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
  try {
    let file = null, line = null, col = null, func = null, error = null, errorType = null;
    // 1. Try exception.values[0].stacktrace.frames
    if (sentryEvent.exception?.values?.length) {
      const exception = sentryEvent.exception.values[0];
      const frames = exception.stacktrace?.frames || [];
      const frame = [...frames].reverse().find(f => f.filename) || frames[frames.length - 1];
      if (frame) {
        file = frame.filename || null;
        line = frame.lineno || null;
        col = frame.colno || null;
        func = frame.function || null;
      }
      error = exception.value || exception.message || null;
      errorType = exception.type || null;
      // Look for response in exception
      if (!error && exception.response) error = exception.response;
    }
    // 2. Try entries array
    if ((!file || !error) && Array.isArray(sentryEvent.entries)) {
      for (const entry of sentryEvent.entries) {
        if (entry.type === 'exception' && entry.data?.values?.length) {
          const entryException = entry.data.values[0];
          const entryFrames = entryException.stacktrace?.frames || [];
          const frame = [...entryFrames].reverse().find(f => f.filename) || entryFrames[entryFrames.length - 1];
          if (frame && !file) {
            file = frame.filename || null;
            line = frame.lineno || null;
            col = frame.colno || null;
            func = frame.function || null;
          }
          if (!error) error = entryException.value || entryException.message || null;
          if (!errorType) errorType = entryException.type || null;
          if (!error && entryException.response) error = entryException.response;
        }
      }
    }
    // 3. Try metadata
    if (!file && sentryEvent.metadata?.filename) file = sentryEvent.metadata.filename;
    if (!error && sentryEvent.metadata?.value) error = sentryEvent.metadata.value;
    if (!errorType && sentryEvent.metadata?.type) errorType = sentryEvent.metadata.type;
    if (!error && sentryEvent.metadata?.message) error = sentryEvent.metadata.message;
    // 4. Try top-level fields
    if (!file && sentryEvent.file) file = sentryEvent.file;
    if (!error && sentryEvent.value) error = sentryEvent.value;
    if (!error && sentryEvent.message) error = sentryEvent.message;
    if (!errorType && sentryEvent.type) errorType = sentryEvent.type;
    if (!error && sentryEvent.response) error = sentryEvent.response;
    // 5. Try culprit
    if (!file && sentryEvent.culprit) file = sentryEvent.culprit;
    if (!file || !error) {
      console.error('parseSentryDetails: Could not extract file or error from event.');
      console.log('Top-level keys:', Object.keys(sentryEvent));
      if (sentryEvent.exception) {
        console.log('Exception keys:', Object.keys(sentryEvent.exception));
        if (Array.isArray(sentryEvent.exception.values)) {
          console.log('Exception.values[0] keys:', Object.keys(sentryEvent.exception.values[0] || {}));
        }
      }
      if (sentryEvent.metadata) {
        console.log('Metadata keys:', Object.keys(sentryEvent.metadata));
      }
      if (Array.isArray(sentryEvent.entries)) {
        console.log('Entries types:', sentryEvent.entries.map(e => e.type));
      }
    }
    return {
      file,
      line,
      col,
      function: func,
      error,
      errorType,
      pre_context: [],
      context_line: '',
      post_context: [],
    };
  } catch (e) {
    console.error('parseSentryDetails: Exception while parsing Sentry event:', e);
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

// Generate a markdown analysis message from Sentry details
function generateSentryAnalysis(details) {
  const {
    errorType,
    error,
    file,
    line,
    col,
    function: func,
    pre_context,
    context_line,
    post_context
  } = details;

  // Format code context
  const codeContext = [
    ...pre_context,
    context_line ? `>> ${context_line}` : '',
    ...post_context
  ].filter(Boolean).join('\n');

  // Suggest a fix based on common ReferenceError
  let suggestion = '';
  if (errorType === 'ReferenceError' && /not defined/.test(error || '')) {
    suggestion = `- Ensure that the variable or function mentioned is defined and in scope.\n- If it should be imported or passed as a prop, make sure it is available in this file.`;
  } else {
    suggestion = `- Review the code context and error message above to identify the root cause.\n- Check for typos, missing imports, or incorrect usage.`;
  }

  return `### 🛠️ Sentry Error Analysis\n\n- **Error:** \`${errorType ? errorType + ': ' : ''}${error}\`\n- **File:** \`${file}\`\n- **Line:** \`${line}${col ? ':' + col : ''}\`\n- **Function:** \`${func || ''}\`\n\n**Context:**\n\n\`\`\`js\n${codeContext}\n\`\`\`\n\n**Suggested Fix:**\n${suggestion}`;
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
      // Accept 'labeled', 'opened', and 'edited' actions
      if (event === 'issues' && ['labeled', 'opened', 'edited'].includes(req.body.action)) {
        const issue = req.body.issue;
        const repo = req.body.repository;
        let hasSentryErrorLabel = false;
        if (req.body.action === 'labeled') {
          const labelName = req.body.label?.name;
          hasSentryErrorLabel = labelName && labelName.toLowerCase() === 'sentry error';
        } else {
          // For 'opened' and 'edited', check all labels
          hasSentryErrorLabel = Array.isArray(issue.labels) && issue.labels.some(l => l.name && l.name.toLowerCase() === 'sentry error');
        }
        console.log('Sentry error label present:', hasSentryErrorLabel);
        if (hasSentryErrorLabel) {
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
            // Check if the comment already exists at the error line
            const needsComment = fileContent[sentryDetails.line - 1] !== comment;
            if (needsComment) {
              fileContent.splice(sentryDetails.line - 1, 0, comment);
              fs.writeFileSync(targetFile, fileContent.join('\n'), 'utf8');
            }
            // Only proceed with commit/PR if there are code changes (not just a comment)
            const repoGit = simpleGit(localPath);
            // Set git user/email before committing
            await repoGit.addConfig('user.email', 'divya@5x.co');
            await repoGit.addConfig('user.name', 'divyask24');
            await repoGit.checkoutLocalBranch(branchName);
            await repoGit.add(sentryDetails.file);
            const status = await repoGit.status();
            if (status.staged.length > 0) {
              await repoGit.commit('fix: add comment for Sentry error');
              // Use a GitHub token with push access
              await repoGit.push(['-u', remoteWithToken, branchName]);
              // Check if a PR already exists for this issue (by branch name or issue number in PR body)
              const existingPRs = await octokit.pulls.list({
                owner: repoOwner,
                repo: repoName,
                state: 'open',
                head: `${repoOwner}:${branchName}`
              });
              if (existingPRs.data && existingPRs.data.length > 0) {
                console.log(`A PR already exists for issue #${issue.number} (branch: ${branchName}). Updating the branch if there are changes.`);
                // Only push if there are changes (already handled above)
              } else {
                await octokit.pulls.create({
                  owner: repoOwner,
                  repo: repoName,
                  title: 'Automated Sentry error fix',
                  head: branchName,
                  base: 'dev',
                  body: `This PR adds a comment for the Sentry error reported in issue #${issue.number}.\n\nIssue ID: ${issue.id}`
                });
                console.log('PR created successfully');
              }
            } else {
              console.log('No code changes detected, skipping commit and PR creation.');
            }

            // Add a comment to the issue with initial analysis
            const analysisMsg = `<!-- sentry-bot-analysis -->\n${generateSentryAnalysis(sentryDetails)}`;
            // Check for existing comment with the marker
            const comments = await octokit.issues.listComments({
              owner: repo.owner.login,
              repo: repo.name,
              issue_number: issue.number,
            });
            const alreadyCommented = comments.data.some(comment => comment.body && comment.body.includes('<!-- sentry-bot-analysis -->'));
            if (!alreadyCommented) {
              await octokit.issues.createComment({
                owner: repo.owner.login,
                repo: repo.name,
                issue_number: issue.number,
                body: analysisMsg
              });
              console.log('Posted initial analysis comment on the issue.');
            } else {
              console.log('Analysis comment already exists on the issue. Skipping duplicate comment.');
            }
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
            const prompt = `A Sentry error was reported in the following file and line.\n\nFile: ${sentryDetails.file}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the file content:\n\n${fileContent}\n\nAnalyze the relevant code context (such as the surrounding lines, function, or code block). Suggest a fix that not only addresses the immediate error but also improves the code's robustness by handling possible edge cases or negative scenarios (e.g., failed API calls, invalid data, exceptions). Apply the fix to the appropriate section of the code, replacing or updating the relevant block as needed. Provide the corrected code for the relevant section.`;
            const response = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo-1106',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 500,
            });
            aiFix = response.choices[0].message.content.trim();
            console.log('AI fix response:', aiFix);

            // Remove logic that adds a comment to the code at the error line
            // Only apply the AI-generated fix if present and valid
            if (aiFix && aiFix.length > 5 && aiFix !== '[Could not read file]') {
              // Try to extract code from a markdown code block if present
              let codeToApply = aiFix;
              const codeBlockMatch = aiFix.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
              if (codeBlockMatch) {
                codeToApply = codeBlockMatch[1].trim();
              }
              if (codeToApply && codeToApply.length > 0) {
                let fileLines = fileContent.split('\n');
                // Only replace the error line if the AI fix is different from the original
                if (codeToApply !== fileLines[sentryDetails.line - 1]) {
                  fileLines.splice(sentryDetails.line - 1, 1, ...codeToApply.split('\n'));
                  fs.writeFileSync(path.join(localPath, sentryDetails.file), fileLines.join('\n'), 'utf8');
                  // Proceed with commit/PR logic as there is a real code change
                  const repoGit = simpleGit(localPath);
                  // Set git user/email before committing
                  await repoGit.addConfig('user.email', 'divya@5x.co');
                  await repoGit.addConfig('user.name', 'divyask24');
                  await repoGit.checkoutLocalBranch(branchName);
                  await repoGit.add(sentryDetails.file);
                  const status = await repoGit.status();
                  if (status.staged.length > 0) {
                    await repoGit.commit('fix: apply AI-generated fix for Sentry error');
                    // Use a GitHub token with push access
                    await repoGit.push(['-u', remoteWithToken, branchName]);
                    // Check if a PR already exists for this issue (by branch name or issue number in PR body)
                    const existingPRs = await octokit.pulls.list({
                      owner: repoOwner,
                      repo: repoName,
                      state: 'open',
                      head: `${repoOwner}:${branchName}`
                    });
                    if (existingPRs.data && existingPRs.data.length > 0) {
                      console.log(`A PR already exists for issue #${issue.number} (branch: ${branchName}). Updating the branch if there are changes.`);
                      // Only push if there are changes (already handled above)
                    } else {
                      await octokit.pulls.create({
                        owner: repoOwner,
                        repo: repoName,
                        title: 'Automated Sentry error fix',
                        head: branchName,
                        base: 'dev',
                        body: `This PR applies an AI-generated fix for the Sentry error reported in issue #${issue.number}.\n\nIssue ID: ${issue.id}`
                      });
                      console.log('PR created successfully');
                    }
                  } else {
                    console.log('No code changes detected after AI fix, skipping commit and PR creation.');
                  }
                } else {
                  console.log('AI fix is identical to the original code. Skipping code change.');
                }
              } else {
                console.log('AI did not return a code block. Skipping code change.');
              }
            } else {
              console.log('No valid AI fix returned. Skipping code change.');
            }
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