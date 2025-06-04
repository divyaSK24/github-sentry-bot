require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const fetch = require('node-fetch');

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
  const match = issueBody.match(/Sentry Event:\s*(https?:\/\/[^\s/]+\/api\/0\/projects\/[^\s]+\/events\/[^\s/]+)\/?/i);
  return match ? match[1] : null;
}

async function fetchSentryEventJson(sentryUrl) {
  const response = await fetch(sentryUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.SENTRY_API_TOKEN}`
    }
  });
  if (!response.ok) throw new Error('Failed to fetch Sentry event JSON');
  return await response.json();
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Respond immediately to GitHub

  // Process the event in the background
  (async () => {
    try {
      const event = req.headers['x-github-event'];
      if (event === 'issues' && req.body.action === 'opened') {
        const issue = req.body.issue;
        const repo = req.body.repository;
        const labels = issue.labels.map(label => label.name);
        if (labels.includes('sentry error')) {
          console.log('Received new Sentry error issue:', issue.title);
          const sentryUrl = extractSentryEventUrl(issue.body);
          if (!sentryUrl) {
            console.error('No Sentry event URL found in issue body');
            return;
          }
          let sentryEvent;
          try {
            sentryEvent = await fetchSentryEventJson(sentryUrl);
          } catch (e) {
            console.error('Could not fetch Sentry event JSON:', e);
            return;
          }
          const sentryDetails = parseSentryDetails(sentryEvent);
          const repoOwner = repo.owner.login;
          const repoName = repo.name;
          const repoUrl = repo.clone_url;
          const branchName = `sentry-fix-${Date.now()}`;
          const localPath = path.join(__dirname, 'tmp', `${repoOwner}-${repoName}-${Date.now()}`);
          const git = simpleGit();
          const remoteWithToken = repoUrl.replace('https://', `https://${process.env.GITHUB_TOKEN}@`);
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
            const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
            await octokit.pulls.create({
              owner: repoOwner,
              repo: repoName,
              title: 'Automated Sentry error fix',
              head: branchName,
              base: 'main',
              body: `This PR adds a comment for the Sentry error reported in #${issue.number}`
            });
            console.log('PR created successfully');
          } catch (err) {
            console.error('Error handling Sentry fix:', err);
          }

          try {
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
        }
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 