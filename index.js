require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper to parse Sentry details from issue body
function parseSentryDetails(sentryEvent) {
  try {
    // Try exception stacktrace frames
    const exception = sentryEvent.exception?.values?.[0];
    const frames = exception?.stacktrace?.frames;
    let lastFrame = frames && frames.length > 0 ? frames[frames.length - 1] : null;

    // Try to get file from various possible fields
    let file = lastFrame?.filename || lastFrame?.abs_path || lastFrame?.module || null;
    let line = lastFrame?.lineno || null;
    let func = lastFrame?.function || null;

    // Fallbacks for Java/other events
    if (!file && sentryEvent.culprit) file = sentryEvent.culprit;
    if (!file && sentryEvent.metadata?.filename) file = sentryEvent.metadata.filename;
    if (!line && sentryEvent.metadata?.line) line = sentryEvent.metadata.line;

    // Fallback to top-level error/message
    let error = exception?.value || sentryEvent.message || sentryEvent.title || sentryEvent.error || null;

    return { file, line, function: func, error };
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

// Generate a markdown analysis message from Sentry details
function generateSentryAnalysis(details) {
  const {
    errorType,
    error,
    file,
    line,
    col,
    function: func,
    pre_context = [],
    context_line = '',
    post_context = []
  } = details;

  // Ensure pre_context and post_context are arrays
  const pre = Array.isArray(pre_context) ? pre_context : [];
  const post = Array.isArray(post_context) ? post_context : [];

  // Format code context
  const codeContext = [
    ...pre,
    context_line ? `>> ${context_line}` : '',
    ...post
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
            let fileContent = fs.readFileSync(targetFile, 'utf8').split('\n');

            // Choose prompt based on repo type
            let aiPrompt;
            if (repoName === '5x-platform-nextgen') {
              // Java backend
              aiPrompt = `A Sentry error was reported in the following Java file and line.\nFile: ${sentryDetails.file}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the file content:\n\n${fileContent.join('\n')}\n\nIf the fix can be made by updating a single Java method or class, return ONLY that complete method or class (with its signature) in a markdown code block. If the fix requires changes in multiple places or is ambiguous, return the entire corrected Java file in a markdown code block.`;
            } else if (repoName === '5x-platform-nextgen-ui') {
              // Next.js frontend
              aiPrompt = `A Sentry error was reported in the following file and line.\nFile: ${sentryDetails.file}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the file content:\n\n${fileContent.join('\n')}\n\nIf the fix can be made by updating a single function, class, or code block, return ONLY that complete block (with its name/signature) in a markdown code block. If the fix requires changes in multiple places or is ambiguous, return the entire corrected file in a markdown code block.`;
            } else {
              // Default (JS/TS)
              aiPrompt = `A Sentry error was reported in the following file and line.\nFile: ${sentryDetails.file}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the file content:\n\n${fileContent.join('\n')}\n\nIf the fix can be made by updating a single function, class, or code block, return ONLY that complete block (with its name/signature) in a markdown code block. If the fix requires changes in multiple places or is ambiguous, return the entire corrected file in a markdown code block.`;
            }

            const combinedResponse = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo-1106',
              messages: [{ role: 'user', content: aiPrompt }],
              max_tokens: 2000,
            });
            let aiFix = combinedResponse.choices[0].message.content.trim();
            const codeBlockMatch = aiFix.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
            if (codeBlockMatch) {
              aiFix = codeBlockMatch[1].trim();
            }
            let blockReplaced = false;
            if (aiFix && aiFix.length > 0) {
              // Try to extract the function/class/method name from the block
              let nameMatch;
              if (repoName === '5x-platform-nextgen') {
                // Java: method or class
                nameMatch = aiFix.match(/(?:public|private|protected)?\s*(?:static)?\s*[\w<>\[\]]+\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/) || aiFix.match(/class\s+([a-zA-Z0-9_]+)/);
              } else {
                // JS/TS: function/class/const
                nameMatch = aiFix.match(/(?:function|class)\s+([a-zA-Z0-9_]+)/) || aiFix.match(/const\s+([a-zA-Z0-9_]+)\s*=\s*\(/);
              }
              if (nameMatch) {
                const blockName = nameMatch[1];
                // Regex to match the block in the file
                let blockRegex;
                if (repoName === '5x-platform-nextgen') {
                  // Java method or class
                  if (/^class /.test(aiFix)) {
                    blockRegex = new RegExp(`class\\s+${blockName}[^]*?\\n\\}`, 'gm');
                  } else {
                    // Method
                    blockRegex = new RegExp(`[\w<>\[\]]+\\s+${blockName}\\s*\([^)]*\)\\s*\{[^]*?\n\}`, 'gm');
                  }
                } else {
                  // JS/TS
                  if (/^class /.test(aiFix)) {
                    blockRegex = new RegExp(`class\\s+${blockName}[^]*?\\n\\}`, 'gm');
                  } else if (/^function /.test(aiFix)) {
                    blockRegex = new RegExp(`function\\s+${blockName}[^]*?\\n\\}`, 'gm');
                  } else {
                    // Arrow function or const
                    blockRegex = new RegExp(`const\\s+${blockName}\\s*=\\s*\\([^]*?\\)\\s*=>[^]*?\\n\\}`, 'gm');
                  }
                }
                const origFile = fileContent.join('\n');
                const replaced = origFile.replace(blockRegex, aiFix);
                if (replaced !== origFile) {
                  fs.writeFileSync(path.join(localPath, sentryDetails.file), replaced, 'utf8');
                  blockReplaced = true;
                  console.log('Targeted block replaced in file.');
                }
              }
            }
            // If block not replaced, treat as full file and overwrite
            if (!blockReplaced && aiFix && aiFix.length > 0) {
              fs.writeFileSync(path.join(localPath, sentryDetails.file), aiFix, 'utf8');
              console.log('AI full file fix received and written.');
            }

            // Run tests before committing
            let testsPassed = true;
            try {
              if (repoName === '5x-platform-nextgen') {
                // Java backend: run mvn test
                execSync('mvn test', { cwd: localPath, stdio: 'inherit' });
              } else {
                // JS/TS: run yarn test
                execSync('yarn test', { cwd: localPath, stdio: 'inherit' });
              }
              console.log('Tests passed after AI fix.');
            } catch (testErr) {
              testsPassed = false;
              console.error('Tests failed after AI fix:', testErr.message || testErr);
            }

            // Only proceed with commit/PR if tests pass
            if (testsPassed) {
              // Proceed with commit/PR logic as there is a real code change
              const repoGit = simpleGit(localPath);
              // Set git user/email before committing
              await repoGit.addConfig('user.email', 'divya@5x.co');
              await repoGit.addConfig('user.name', 'divyask24');
              // Robust branch handling
              await repoGit.fetch();
              const branches = await repoGit.branch(['-a']);
              const remoteBranch = `remotes/origin/${branchName}`;
              try {
                if (branches.all.includes(branchName)) {
                  await repoGit.checkout(branchName);
                  console.log(`Checked out existing local branch: ${branchName}`);
                } else if (branches.all.includes(remoteBranch)) {
                  await repoGit.checkout(['-b', branchName, '--track', remoteBranch]);
                  console.log(`Checked out tracking branch from remote: ${branchName}`);
                } else {
                  await repoGit.checkoutLocalBranch(branchName);
                  console.log(`Created and checked out new branch: ${branchName}`);
                }
              } catch (branchErr) {
                console.error('Branch checkout/creation error:', branchErr);
                throw branchErr;
              }
              await repoGit.add(sentryDetails.file);
              const status = await repoGit.status();
              if (status.staged.length > 0) {
                // Run yarn format and lint --fix before commit
                let formatSuccess = false;
                let lintSuccess = false;
                let formatError = '';
                let lintError = '';
                for (let attempt = 0; attempt < 2; attempt++) {
                  try {
                    execSync('yarn format', { cwd: localPath, stdio: 'inherit' });
                    formatSuccess = true;
                  } catch (err) {
                    formatError = err.message || String(err);
                    console.error('yarn format failed:', formatError);
                    if (attempt === 0) {
                      // Try to fix with Codex
                      const prompt = `The following codebase failed to format with Prettier. Error: ${formatError}\nSuggest a fix for the formatting error in file: ${sentryDetails.file}`;
                      const response = await openai.chat.completions.create({
                        model: 'gpt-3.5-turbo-1106',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 500,
                      });
                      const fix = response.choices[0].message.content.trim();
                      if (fix && fix.length > 0) {
                        fs.writeFileSync(path.join(localPath, sentryDetails.file), fix, 'utf8');
                        continue;
                      }
                    }
                    break;
                  }
                  break;
                }
                for (let attempt = 0; attempt < 2; attempt++) {
                  try {
                    execSync('yarn lint --fix', { cwd: localPath, stdio: 'inherit' });
                    lintSuccess = true;
                  } catch (err) {
                    lintError = err.message || String(err);
                    console.error('yarn lint --fix failed:', lintError);
                    if (attempt === 0) {
                      // Try to fix with Codex
                      const prompt = `The following codebase failed to lint with ESLint. Error: ${lintError}\nSuggest a fix for the lint error in file: ${sentryDetails.file}`;
                      const response = await openai.chat.completions.create({
                        model: 'gpt-3.5-turbo-1106',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 500,
                      });
                      const fix = response.choices[0].message.content.trim();
                      if (fix && fix.length > 0) {
                        fs.writeFileSync(path.join(localPath, sentryDetails.file), fix, 'utf8');
                        continue;
                      }
                    }
                    break;
                  }
                  break;
                }
                if (!formatSuccess || !lintSuccess) {
                  console.error('Format or lint failed, skipping commit.');
                } else {
                  await repoGit.add(sentryDetails.file);
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
                    const prTitle = `[Sentry] Fix: ${issue.title} (#${issue.number})`;
                    await octokit.pulls.create({
                      owner: repoOwner,
                      repo: repoName,
                      title: prTitle,
                      head: branchName,
                      base: 'dev',
                      body: `This PR applies an AI-generated fix for the Sentry error reported in issue #${issue.number}.\n\nIssue ID: ${issue.id}\nTimestamp: ${Date.now()}`
                    });
                    console.log('PR created successfully');
                  }
                }
              } else {
                console.log('No code changes detected after AI fix, skipping commit and PR creation.');
              }
            } else {
              console.error('Skipping commit/PR because tests failed after AI fix.');
            }

            // If AI could not generate a fix, log and alert for manual review
            if (!aiFix || aiFix.length < 5) {
              console.warn('AI could not generate a fix. Logging for manual review.');
              await octokit.issues.createComment({
                owner: repoOwner,
                repo: repoName,
                issue_number: issue.number,
                body: `:warning: The bot could not automatically fix the Sentry error. Manual intervention is required.\n\nError: ${sentryDetails.error}`
              });
            }
          } catch (err) {
            console.error('OpenAI API error:', err);
            aiFix = null;
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