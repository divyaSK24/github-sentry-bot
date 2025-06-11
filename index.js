require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { execSync } = require('child_process');
const glob = require('glob');
const diff = require('diff');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper to parse Sentry details from issue body
function parseSentryDetails(sentryEvent) {
  try {
    // 1. Try exception stacktrace frames
    const exception = sentryEvent.exception?.values?.[0];
    const frames = exception?.stacktrace?.frames;
    
    // Find the first frame that's in our application code
    let errorFrame = null;
    if (frames && frames.length > 0) {
      for (const frame of frames) {
        const framePath = frame.filename || frame.abs_path || frame.module;
        if (framePath && framePath.includes('src/') && frame.in_app !== false) {
          errorFrame = frame;
          break;
        }
      }
      // If no src/ frame found, use the first frame
      if (!errorFrame) {
        errorFrame = frames[0];
      }
    }

    let file = errorFrame?.filename || errorFrame?.abs_path || errorFrame?.module || null;
    let line = errorFrame?.lineno || null;
    let col = errorFrame?.colno || null;
    let func = errorFrame?.function || null;
    let pre_context = errorFrame?.pre_context || [];
    let context_line = errorFrame?.context_line || '';
    let post_context = errorFrame?.post_context || [];
    let errorType = exception?.type || null;
    let error = exception?.value || null;

    // If we still can't find the error in our code, try to find any frame with source code
    if (!file || !line) {
      for (const frame of frames || []) {
        if (frame.filename && frame.lineno) {
          file = frame.filename || frame.abs_path || frame.module;
          line = frame.lineno;
          col = frame.colno;
          func = frame.function;
          pre_context = frame.pre_context || pre_context;
          context_line = frame.context_line || context_line;
          post_context = frame.post_context || post_context;
          break;
        }
      }
    }

    // 2. Fallbacks for Java/other events
    if (!file && sentryEvent.culprit) file = sentryEvent.culprit;
    if (!file && sentryEvent.transaction) file = sentryEvent.transaction;
    if (!file && sentryEvent.request?.url) file = sentryEvent.request.url;
    if (!file && sentryEvent.request?.method) file = `${sentryEvent.request.method} ${file || ''}`;
    if (!file && sentryEvent.metadata?.filename) file = sentryEvent.metadata.filename;
    if (!line && sentryEvent.metadata?.line) line = sentryEvent.metadata.line;

    // 3. Try tags/context for endpoint/controller
    if (!file && sentryEvent.tags) {
      for (const tag of sentryEvent.tags) {
        if (Array.isArray(tag) && tag[0] && /endpoint|url|route|controller/i.test(tag[0])) {
          file = tag[1];
          break;
        }
      }
    }
    if (!file && sentryEvent.contexts?.trace?.op) file = sentryEvent.contexts.trace.op;

    // 4. Fallback to logentry/message if error not found
    if (!error) {
      error = sentryEvent.logentry?.message || sentryEvent.message || sentryEvent.title || sentryEvent.error || null;
    }

    // 5. Try to extract controller/service from error message if nothing else
    if (!file && error) {
      const match = error.match(/([A-Za-z0-9]+Controller|Service|Repository)/);
      if (match) file = match[1];
    }

    // 6. Fallback to transaction name if still nothing
    if (!file && sentryEvent.transaction) file = sentryEvent.transaction;

    // 7. Extract type, value, category from multiple locations
    if (!errorType) {
      errorType = sentryEvent.type || sentryEvent.metadata?.type || null;
    }
    if (!error) {
      error = sentryEvent.value || sentryEvent.metadata?.value || null;
    }
    let category = sentryEvent.category || sentryEvent.metadata?.category || null;

    // 8. Try top-level fields if not found
    if (!errorType && sentryEvent['type']) errorType = sentryEvent['type'];
    if (!error && sentryEvent['value']) error = sentryEvent['value'];
    if (!category && sentryEvent['category']) category = sentryEvent['category'];

    // 9. As a last resort, search the entire JSON for a file path with a known extension
    if (!file) {
      const exts = ['java', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rb', 'php', 'cs', 'cpp', 'c', 'kt', 'swift'];
      const fileRegex = new RegExp(`[\\w/\\\\.-]+\\.(${exts.join('|')})`, 'gi');
      const jsonString = JSON.stringify(sentryEvent);
      const matches = jsonString.match(fileRegex);
      if (matches && matches.length > 0) {
        file = matches[0];
      }
    }

    return { 
      file, 
      line, 
      col,
      function: func, 
      error, 
      errorType, 
      category,
      pre_context,
      context_line,
      post_context
    };
  } catch (e) {
    console.error('Error parsing Sentry details:', e);
    return { 
      file: null, 
      line: null, 
      col: null,
      error: null, 
      errorType: null, 
      category: null,
      pre_context: [],
      context_line: '',
      post_context: []
    };
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

function normalizeSentryFilePath(filePath) {
  if (!filePath) return null;
  // Remove Sentry/Next.js prefixes
  filePath = filePath.replace(/^app:\/\//, '');
  filePath = filePath.replace(/^_next\/static\/chunks\/pages\//, '');
  filePath = filePath.replace(/^\//, '');
  // If path starts with 'src/', keep as is
  if (filePath.startsWith('src/')) return filePath;
  // Try to extract src path if present
  const srcIdx = filePath.indexOf('src/');
  if (srcIdx !== -1) return filePath.slice(srcIdx);
  return filePath;
}

function extractSrcFrame(sentryEvent) {
  // 1. Exception stacktrace
  const exception = sentryEvent.exception?.values?.[0];
  const frames = exception?.stacktrace?.frames || [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (
      ((f.filename && f.filename.includes('src/') && /\.(js|ts|jsx|tsx)$/.test(f.filename)) ||
      (f.abs_path && f.abs_path.includes('src/') && /\.(js|ts|jsx|tsx)$/.test(f.abs_path)))
    ) {
      return {
        file: f.filename || f.abs_path,
        line: f.lineno || null,
        function: f.function || null
      };
    }
  }
  // 2. Other fields
  if (sentryEvent.logentry?.filename) {
    return { file: sentryEvent.logentry.filename, line: null, function: null };
  }
  if (sentryEvent.metadata?.filename) {
    return { file: sentryEvent.metadata.filename, line: sentryEvent.metadata.line || null, function: null };
  }
  if (sentryEvent.culprit) {
    return { file: sentryEvent.culprit, line: null, function: null };
  }
  if (sentryEvent.transaction) {
    return { file: sentryEvent.transaction, line: null, function: null };
  }
  // 3. Fallback: search JSON for src/.*\.(js|ts|jsx|tsx)
  const jsonString = JSON.stringify(sentryEvent);
  const match = jsonString.match(/src\/[^"']+\.(js|ts|jsx|tsx)/);
  if (match) {
    return { file: match[0], line: null, function: null };
  }
  // 4. Fallback: last frame
  if (frames.length > 0) {
    const last = frames[frames.length - 1];
    return {
      file: last.filename || last.abs_path || null,
      line: last.lineno || null,
      function: last.function || null
    };
  }
  return { file: null, line: null, function: null };
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
            // Log the full stacktrace frames for debugging
            const frames = sentryEvent.exception?.values?.[0]?.stacktrace?.frames;
            console.log('Sentry stacktrace frames:', frames);
          } catch (e) {
            console.error('Could not fetch Sentry event JSON:', e);
            return;
          }
          const sentryDetails = extractSrcFrame(sentryEvent);
          console.log('Extracted srcFrame:', sentryDetails);
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
            if (repoName === '5x-platform-nextgen') {
              // === Java Backend Flow ===
              // Map Sentry error to Java file (using endpoint/class/method search)
              const normalizedFile = normalizeSentryFilePath(sentryDetails.file);
              let targetFile = path.join(localPath, normalizedFile);
              if (!fs.existsSync(targetFile)) {
                const searchTerm = normalizedFile || sentryDetails.function || sentryDetails.error;
                const allFiles = glob.sync('**/*.java', { cwd: localPath, absolute: true });
                const matchingFiles = allFiles.filter(f => {
                  try {
                    const content = fs.readFileSync(f, 'utf8');
                    return content.includes(searchTerm);
                  } catch (e) { return false; }
                });
                if (matchingFiles.length === 1) {
                  targetFile = matchingFiles[0];
                  console.log(`Mapped Sentry file to actual file: ${targetFile}`);
                } else if (matchingFiles.length > 1) {
                  targetFile = matchingFiles.sort((a, b) => a.length - b.length)[0];
                  console.log(`Multiple matches, using: ${targetFile}`);
                } else {
                  await octokit.issues.createComment({
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: issue.number,
                    body: `:warning: The bot could not map the Sentry error ([32m${normalizedFile}[39m) to a source file. Manual intervention is required.\n\nError: ${sentryDetails.error}`
                  });
                  return;
                }
              }
            let fileContent = fs.readFileSync(targetFile, 'utf8').split('\n');
              // Java-specific AI prompt using gpt-3.5-turbo
              const codeContext = fileContent.slice(Math.max(0, sentryDetails.line - 6), sentryDetails.line + 5).join('\n');
              const aiPrompt = `A Sentry error was reported in the following Java file and line.\nFile: ${normalizedFile}\nLine: ${sentryDetails.line}\nError: ${sentryDetails.error}\n\nHere is the code context:\n${codeContext}\n\nPlease return the fixed code for this file or function, in a markdown code block, with no explanation.`;
              console.log('AI Prompt (Java):', aiPrompt);
              const gptResponse = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: aiPrompt }],
                max_tokens: 1500,
                temperature: 0,
              });
              console.log('AI Response (Java):', gptResponse.choices[0].message.content);
              let aiFix = gptResponse.choices[0].message.content.trim();
              const codeBlockMatch = aiFix.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
              if (codeBlockMatch) {
                aiFix = codeBlockMatch[1].trim();
              }
              let blockReplaced = false;
              if (aiFix && aiFix.length > 0) {
                let nameMatch = aiFix.match(/(?:public|private|protected)?\s*(?:static)?\s*[\w<>\[\]]+\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/) || aiFix.match(/class\s+([a-zA-Z0-9_]+)/);
                if (nameMatch) {
                  const blockName = nameMatch[1];
                  let blockRegex;
                  if (/^class /.test(aiFix)) {
                    blockRegex = new RegExp(`class\\s+${blockName}[^]*?\\n\\}`, 'gm');
                  } else {
                    blockRegex = new RegExp(`[\w<>\[\]]+\\s+${blockName}\\s*\([^)]*\)\\s*\{[^]*?\n\}`, 'gm');
                  }
                  const origFile = fileContent.join('\n');
                  const replaced = origFile.replace(blockRegex, aiFix);
                  if (replaced !== origFile) {
                    fs.writeFileSync(targetFile, replaced, 'utf8');
                    blockReplaced = true;
                    console.log('Targeted Java block replaced in file.');
                  }
                }
              }
              if (!blockReplaced && aiFix && aiFix.length > 0) {
                fs.writeFileSync(targetFile, aiFix, 'utf8');
                console.log('AI full Java file fix received and written.');
              }
              // Run mvn test
              let testsPassed = true;
              try {
                execSync('mvn test', { cwd: localPath, stdio: 'inherit' });
                console.log('Java tests passed after AI fix.');
              } catch (testErr) {
                testsPassed = false;
                console.error('Java tests failed after AI fix:', testErr.message || testErr);
              }
              if (testsPassed) {
                // Proceed with commit/PR logic for Java
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
                await repoGit.add(normalizedFile);
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
                } else {
                  console.log('No code changes detected after AI fix, skipping commit and PR creation.');
                }
              } else {
                console.error('Skipping commit/PR because Java tests failed after AI fix.');
              }
              if (!aiFix || aiFix.length < 5) {
                console.warn('AI could not generate a Java fix. Logging for manual review.');
            await octokit.issues.createComment({
                  owner: repoOwner,
                  repo: repoName,
              issue_number: issue.number,
                  body: `:warning: The bot could not automatically fix the Sentry error. Manual intervention is required.\n\nError: ${sentryDetails.error}`
                });
              }
            } else if (repoName === '5x-platform-nextgen-ui') {
              // === Next.js Frontend Flow ===
              const normalizedFile = normalizeSentryFilePath(sentryDetails.file);
              let targetFile = path.join(localPath, normalizedFile);
              if (!fs.existsSync(targetFile)) {
                const searchTerm = normalizedFile || sentryDetails.function || sentryDetails.error;
                const allFiles = glob.sync('**/*.{js,ts,jsx,tsx}', { cwd: localPath, absolute: true });
                const matchingFiles = allFiles.filter(f => {
                  try {
                    const content = fs.readFileSync(f, 'utf8');
                    return content.includes(searchTerm);
                  } catch (e) { return false; }
                });
                if (matchingFiles.length === 1) {
                  targetFile = matchingFiles[0];
                  console.log(`Mapped Sentry file to actual file: ${targetFile}`);
                } else if (matchingFiles.length > 1) {
                  targetFile = matchingFiles.sort((a, b) => a.length - b.length)[0];
                  console.log(`Multiple matches, using: ${targetFile}`);
                } else {
                  await octokit.issues.createComment({
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: issue.number,
                    body: `:warning: The bot could not map the Sentry error ([32m${normalizedFile}[39m) to a source file. Manual intervention is required.\n\nError: ${sentryDetails.error}`
                  });
                  return;
                }
              }
              let fileContent = fs.readFileSync(targetFile, 'utf8').split('\n');
              // Extract error details for prompt
              const exceptionValue = sentryEvent.exception?.values?.[0]?.value || sentryDetails.error || 'Unknown error';
              const contextLine = sentryDetails.context_line || '';
              const postContext = Array.isArray(sentryDetails.post_context) ? sentryDetails.post_context.join('\n') : '';
              // 1. AI Error Analysis
              const analysisPrompt = `A Sentry error was reported in this file:
File: ${normalizedFile}
Line: ${sentryDetails.line}
Error: ${exceptionValue}
Context line: ${contextLine}
Post-context:
${postContext}

Please analyze the error and suggest what might be causing it and how a developer could fix it.`;
              const analysisResponse = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: analysisPrompt }],
                max_tokens: 500,
                temperature: 0,
              });
              const analysis = analysisResponse.choices[0].message.content.trim();
              // 2. Post analysis as a comment
              await octokit.issues.createComment({
                owner: repoOwner,
                repo: repoName,
                issue_number: issue.number,
                body: `**AI Error Analysis:**\n${analysis}`
              });
              // 3. AI Code Fix Prompt
              const codeBlock = fileContent.slice(Math.max(0, sentryDetails.line - 5), sentryDetails.line + 5).join('\n');
              const fixPrompt = `A Sentry error was reported in this code block:
File: ${normalizedFile}
Line: ${sentryDetails.line}
Error: ${exceptionValue}

Here is the code block with context:
\`\`\`js
${codeBlock}
\`\`\`

Please return ONLY the fixed version of this code block, making minimal changes needed to resolve the error. Add a clear comment at the location where you make code changes. Do not return the entire file. Return the fixed block in a markdown code block.`;
              const fixResponse = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: fixPrompt }],
                max_tokens: 2000,
                temperature: 0,
              });
              let aiFix = fixResponse.choices[0].message.content.trim();
              const codeBlockMatch = aiFix.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
              if (codeBlockMatch) {
                aiFix = codeBlockMatch[1].trim();
              }

              // Apply the fix to the specific block in the file
              const startLine = Math.max(0, sentryDetails.line - 5);
              const endLine = sentryDetails.line + 5;
              const originalBlock = fileContent.slice(startLine, endLine).join('\n');
              
              // Compare the original block with the AI fix
              const changes = diff.diffLines(originalBlock, aiFix);
              const hasMeaningfulChange = changes.some(change =>
                (change.added || change.removed) &&
                change.value.replace(/\s/g, '').length > 0
              );

              if (hasMeaningfulChange) {
                // Replace the block in the file content
                fileContent.splice(startLine, endLine - startLine, ...aiFix.split('\n'));
                // Write the updated content back to the file
                fs.writeFileSync(targetFile, fileContent.join('\n'), 'utf8');
                console.log('AI fix applied to specific block in file:', targetFile);
                // Proceed with commit and PR logic
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
                await repoGit.add(normalizedFile);
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
                } else {
                  console.log('No code changes detected after AI fix, skipping commit and PR creation.');
                }
              } else {
                console.warn('AI fix is not meaningful or is destructive. Skipping file update, commit, and PR.');
                return;
              }
            } else {
              // ...default/other repo logic or skip...
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