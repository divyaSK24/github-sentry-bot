require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper to parse Sentry details from issue body
function parseSentryDetails(sentryEvent) {
  // Sentry event JSON: extract from exception.values[0].stacktrace.frames (last frame is where error occurred)
  try {
    const exception = sentryEvent.exception?.values?.[0];
    const frames = exception?.stacktrace?.frames;
    const lastFrame = frames && frames.length > 0 ? frames[frames.length - 1] : null;
    return {
      file: lastFrame?.filename || null,
      line: lastFrame?.lineno || null,
      error: exception?.value || sentryEvent.message || null,
    };
  } catch (e) {
    return { file: null, line: null, error: null };
  }
}

function extractSentryEventUrl(issueBody) {
  if (typeof issueBody === 'object' && issueBody !== null) {
    if (typeof issueBody.sentryUrl === 'string') {
      const cleanUrl = issueBody.sentryUrl.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\/?$/, '/');
      console.log('Extracted Sentry event URL:', cleanUrl);
      return cleanUrl;
    }
    for (const key in issueBody) {
      if (typeof issueBody[key] === 'string') {
        const url = extractSentryEventUrl(issueBody[key]);
        if (url) return url;
      }
    }
    return null;
  }
  if (typeof issueBody === 'string') {
    const lines = issueBody.split('\n');
    for (const line of lines) {
      console.log('Checking line for Sentry URL:', line);
      // First, look for lines containing 'sentryUrl' (case-insensitive)
      if (line.toLowerCase().includes('sentryurl')) {
        const urlMatch = line.match(/https?:\/\/[^\s"']+/i);
        if (urlMatch) {
          const cleanUrl = urlMatch[0].replace(/^["'\s]+|["'\s]+$/g, '').replace(/\/?$/, '/');
          console.log('Extracted Sentry event URL from sentryUrl line:', cleanUrl);
          return cleanUrl;
        }
      }
      // Next, look for any line with 'sentry' and 'http'
      if (/sentry.*https?:\/\//i.test(line)) {
        const urlMatch = line.match(/https?:\/\/[^\s"']+/i);
        if (urlMatch) {
          const cleanUrl = urlMatch[0].replace(/^["'\s]+|["'\s]+$/g, '').replace(/\/?$/, '/');
          console.log('Extracted Sentry event URL from line:', cleanUrl);
          return cleanUrl;
        }
      }
    }
    // Fallback: match any Sentry event API URL
    const urlMatch = issueBody.match(/https?:\/\/[^\s"']+sentry\.io\/api\/0\/projects\/[^\s"']+\/events\/[a-z0-9]+\/?/i);
    if (urlMatch) {
      const cleanUrl = urlMatch[0].replace(/^["'\s]+|["'\s]+$/g, '').replace(/\/?$/, '/');
      console.log('Extracted Sentry event URL:', cleanUrl);
      return cleanUrl;
    } else {
      console.error('No Sentry event URL found in issue body:', issueBody);
    }
  }
  return null;
}

async function fetchSentryEventJson(sentryUrl) {
  // Always ensure a single trailing slash
  let url = sentryUrl.replace(/\/+$/, '') + '/';
  let response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.SENTRY_API_TOKEN}`
    }
  });

  if (!response.ok) {
    console.error(`Fetch failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error('Response body:', text);
    throw new Error('Failed to fetch Sentry event JSON');
  }
  return await response.json();
}

app.post('/webhook', async (req, res) => {
  console.log('Webhook received:', {
    event: req.headers['x-github-event'],
    action: req.body.action,
    issueTitle: req.body.issue?.title,
    issueNumber: req.body.issue?.number
  });
  res.status(200).send('OK'); // Respond immediately to GitHub

  // Process the event in the background
  (async () => {
    try {
      const event = req.headers['x-github-event'];
      if (event === 'issues' && req.body.action === 'labeled') {
        const issue = req.body.issue;
        const repo = req.body.repository;
        const labelName = req.body.label?.name;
        console.log('Label added:', labelName);
        if (labelName && labelName.toLowerCase() === 'sentry error') {
          console.log('Processing issue because "sentry error" label was added:', issue.title);
          const sentryUrl = extractSentryEventUrl(issue.body);
          if (!sentryUrl) {
            console.error('No Sentry event URL found in issue body:', issue.body);
            return;
          }
          console.log('Attempting to fetch Sentry event JSON from:', sentryUrl);
          let sentryEvent;
          try {
            sentryEvent = await fetchSentryEventJson(sentryUrl);
            console.log('Fetched Sentry event JSON successfully.');
          } catch (e) {
            console.error('Could not fetch Sentry event JSON:', e);
            return;
          }
          const sentryDetails = parseSentryDetails(sentryEvent);
          console.log('Parsed Sentry details:', sentryDetails);
          if (!sentryDetails.file) {
            console.error('No file found in Sentry details:', sentryDetails);
            return;
          }
          const repoOwner = repo.owner.login;
          const repoName = repo.name;
          const repoUrl = repo.clone_url;
          const branchName = `sentry-fix-${Date.now()}`;
          const localPath = path.join(__dirname, 'tmp', `${repoOwner}-${repoName}-${Date.now()}`);
          const git = simpleGit();
          const remoteWithToken = repoUrl.replace('https://', `https://${process.env.GITHUB_TOKEN}@`);
          const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
          let aiFix;
          try {
            // Clone the repo with authentication
            await git.clone(remoteWithToken, localPath);
            const targetFile = path.join(localPath, sentryDetails.file);
            // Read file and insert comment at the error line
            let fileContent = fs.readFileSync(targetFile, 'utf8').split('\n');
            const comment = `// Sentry error here: ${sentryDetails.error}`;
            fileContent.splice(sentryDetails.line - 1, 0, comment);
            fs.writeFileSync(targetFile, fileContent.join('\n'), 'utf8');
            // Commit and push
            const repoGit = simpleGit(localPath);
            await repoGit.checkoutLocalBranch(branchName);
            await repoGit.add(sentryDetails.file);
            await repoGit.commit('fix: add comment for Sentry error');
            // Use a GitHub token with push access
            await repoGit.push(['-u', remoteWithToken, branchName]);
            // Create PR
            await octokit.pulls.create({
              owner: repoOwner,
              repo: repoName,
              title: 'Automated Sentry error fix',
              head: branchName,
              base: 'main',
              body: `This PR adds a comment for the Sentry error reported in #${issue.number}`
            });
            console.log('PR created successfully');

            // Add a comment to the issue with initial analysis
            const analysisMsg = `\n🛠️ **Initial Sentry Analysis**\n- **Error:** ${sentryDetails.error}\n- **File:** ${sentryDetails.file}\n- **Line:** ${sentryDetails.line}\n\nThe bot will now attempt to apply an automated fix.\n`;
            await octokit.issues.createComment({
              owner: repo.owner.login,
              repo: repo.name,
              issue_number: issue.number,
              body: analysisMsg
            });
            console.log('Posted initial analysis comment on the issue.');
          } catch (err) {
            console.error('Error handling Sentry fix:', err);
          }

          try {
            // Compose a prompt for OpenAI
            let fileContent = '';
            try {
              fileContent = fs.readFileSync(path.join(localPath, sentryDetails.file), 'utf8');
            } catch (e) {
              fileContent = '[Could not read file]';
            }
            const prompt = `A Sentry error was reported in the following file and line.\n\nFile: ${sentryDetails.file}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the file content:\n\n${fileContent}\n\nSuggest a fix for the error, and provide the corrected code for the relevant section.`;
            const response = await openai.createChatCompletion({
              model: 'gpt-4',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 500,
            });
            aiFix = response.data.choices[0].message.content.trim();
          } catch (err) {
            console.error('OpenAI API error:', err);
            aiFix = null;
          }

          if (!aiFix || aiFix.length < 5) {
            // Fallback: Add a comment to the GitHub issue for manual intervention
            await octokit.issues.createComment({
              owner: repoOwner,
              repo: repoName,
              issue_number: issue.number,
              body: `:warning: The bot could not automatically fix the Sentry error. Manual intervention is required.\n\nError: ${sentryDetails.error}`
            });
            console.log('AI fix failed, added comment to issue for manual intervention.');
            return;
          }
        } else {
          console.log('Label added is not "sentry error". Skipping.');
        }
      } else {
        console.log('Webhook event is not a label addition. Skipping.');
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 