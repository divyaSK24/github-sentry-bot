require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { execSync } = require('child_process');
const glob = require('glob');
const diff = require('diff');
const ContextBuilder = require('./src/utils/contextBuilder');
const ErrorAnalysisService = require('./src/services/errorAnalysisService');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// Health check endpoint for deployment platforms
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    port: PORT 
  });
});

// Root endpoint for basic connectivity test
app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'GitHub Sentry Bot is running',
    version: '1.0.0',
    endpoints: ['/health', '/webhook']
  });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize GitHub Octokit client using dynamic import
let octokit;
(async () => {
  const { Octokit } = await import('@octokit/rest');
  octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });
})();

// Helper to parse Sentry details from issue body
function parseSentryDetails(sentryEvent) {
  try {
    // 1. Try exception stacktrace frames
    const exception = sentryEvent.exception?.values?.[0];
    const frames = exception?.stacktrace?.frames;
    
    // Find all frames that are in our application code
    let errorFrames = [];
    let errorFrame = null;
    if (frames && frames.length > 0) {
      for (const frame of frames) {
        const framePath = frame.filename || frame.abs_path || frame.module;
        // Check if it's our application code and has source context
        if (framePath && 
            framePath.includes('src/') && 
            frame.in_app !== false && 
            (frame.pre_context || frame.context_line || frame.post_context)) {
          const frameData = {
            file: framePath,
            line: frame.lineno,
            col: frame.colno,
            func: frame.function,
            pre_context: frame.pre_context || [],
            context_line: frame.context_line || '',
            post_context: frame.post_context || [],
            // Add additional context if available
            vars: frame.vars || {},
            data: frame.data || {}
          };
          errorFrames.push(frameData);
          // Keep the first matching frame as the primary error frame
          if (!errorFrame) {
            errorFrame = frame;
          }
        }
      }
      // If no src/ frame found, use the first frame with context
      if (!errorFrame) {
        for (const frame of frames) {
          if (frame.pre_context || frame.context_line || frame.post_context) {
            errorFrame = frame;
            break;
          }
        }
        // If still no frame with context, use the first frame
        if (!errorFrame) {
          errorFrame = frames[0];
        }
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
      post_context,
      errorFrames // Include all in_app frames for context
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
      post_context: [],
      errorFrames: []
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

// Update the AI prompt to include all error frames with better formatting
const formatFrameContext = (frame) => {
  const preContext = Array.isArray(frame.pre_context) ? frame.pre_context : [];
  const postContext = Array.isArray(frame.post_context) ? frame.post_context : [];
  const context = [
    ...preContext,
    frame.context_line ? `>> ${frame.context_line}` : '',
    ...postContext
  ].filter(Boolean).join('\n');

  return `
File: ${frame.file}
Line: ${frame.line}${frame.col ? `:${frame.col}` : ''}
Function: ${frame.func || 'unknown'}

Code Context:
\`\`\`js
${context}
\`\`\`
${frame.vars && Object.keys(frame.vars).length > 0 ? `
Variables:
\`\`\`js
${JSON.stringify(frame.vars, null, 2)}
\`\`\`
` : ''}`;
};

// Enhanced error analysis using OpenAI
async function analyzeErrorWithAI(sentryEvent, repoPath) {
  try {
    // Extract error details
    const errorDetails = parseSentryDetails(sentryEvent);
    if (!errorDetails.file || !errorDetails.line) {
      throw new Error('Could not determine error location');
    }

    // Build comprehensive context
    const contextBuilder = new ContextBuilder();
    const context = await contextBuilder.buildContext(
      path.join(repoPath, errorDetails.file),
      errorDetails.line,
      repoPath
    );
    
    // Analyze error with OpenAI
    const openaiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert at analyzing and fixing code errors. Provide detailed analysis and fixes."
        },
        {
          role: "user",
          content: `Analyze this error and provide a fix:\n\nError: ${errorDetails.error}\nType: ${errorDetails.errorType}\nFile: ${errorDetails.file}\nLine: ${errorDetails.line}\n\nContext:\n${context}`
        }
      ],
      temperature: 0.3
    });

    const response = openaiResponse.choices[0].message.content;
    
    // Parse the response to extract analysis and fix
    const sections = response.split('\n\n');
    const analysisResult = {
      error: errorDetails.error,
      errorType: errorDetails.errorType,
      rootCause: sections.find(s => s.includes('Root Cause:'))?.replace('Root Cause:', '').trim() || 'Unknown',
      confidence: 0.8, // Default confidence for OpenAI
      suggestedFixes: sections.find(s => s.includes('Fix:'))?.replace('Fix:', '').trim() || '',
      testImpact: sections.find(s => s.includes('Test Impact:'))?.replace('Test Impact:', '').trim() || 'Unknown'
    };

    return {
      analysis: analysisResult,
      fix: {
        code: analysisResult.suggestedFixes,
        explanation: analysisResult.rootCause
      },
      confidence: analysisResult.confidence,
      context
    };
  } catch (error) {
    console.error('AI analysis error:', error);
    return null;
  }
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
      if (event === 'issues' && ['labeled', 'opened', 'edited'].includes(req.body.action)) {
        const issue = req.body.issue;
        const repo = req.body.repository;
        let hasSentryErrorLabel = false;
        
        // Check for Sentry error label
        if (req.body.action === 'labeled') {
          const labelName = req.body.label?.name;
          hasSentryErrorLabel = labelName && labelName.toLowerCase() === 'sentry error';
        } else {
          hasSentryErrorLabel = Array.isArray(issue.labels) && 
            issue.labels.some(l => l.name && l.name.toLowerCase() === 'sentry error');
        }

        if (hasSentryErrorLabel) {
          console.log('Processing issue because "sentry error" label was added:', issue.title);
          const sentryUrl = extractSentryEventUrl(issue.body);
          
          if (!sentryUrl) {
            console.error('No Sentry event URL found in issue body:', issue.body);
            return;
          }

          try {
            const sentryEvent = await fetchSentryEventJson(sentryUrl);
            
            // Create a cleaner repository path
            const repoName = repo.name.replace(/[^a-zA-Z0-9-_]/g, '-');
            const repoPath = path.join(__dirname, 'tmp', `${repo.owner.login}-${repoName}-${Date.now()}`);
            
            console.log('Repository path:', repoPath);
            console.log('Repository details:', { owner: repo.owner.login, name: repo.name, fullName: repo.full_name });
            
            // Clone the repository first
            console.log('Cloning repository...');
            try {
              const git = simpleGit();
              // Use the full repository URL from the webhook payload with authentication
              const repoUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${repo.owner.login}/${repo.name}.git`;
              console.log('Cloning from:', `https://github.com/${repo.owner.login}/${repo.name}.git`);
              
              try {
                await git.clone(repoUrl, repoPath);
                console.log('Repository cloned successfully to:', repoPath);
              } catch (tokenError) {
                console.warn('Token-based cloning failed, trying alternative method:', tokenError.message);
                // Fallback: try with SSH-style URL or public access
                const fallbackUrl = `https://github.com/${repo.owner.login}/${repo.name}.git`;
                await git.clone(fallbackUrl, repoPath);
                console.log('Repository cloned successfully with fallback method to:', repoPath);
              }
            } catch (cloneError) {
              console.error('Failed to clone repository:', cloneError.message);
              throw new Error(`Failed to clone repository: ${cloneError.message}`);
            }
            
            // Initialize error analysis service
            const errorAnalysis = new ErrorAnalysisService();
            
            // Get error details
            const errorDetails = parseSentryDetails(sentryEvent);
            if (!errorDetails.file || !errorDetails.line) {
              throw new Error('Could not determine error location');
            }

            console.log('Error details:', errorDetails);
            console.log('Full file path:', path.join(repoPath, errorDetails.file));

            // Analyze error
            const analysis = await errorAnalysis.analyzeError(errorDetails, repoPath);
            
            if (analysis.suggestedFixes.length > 0) {
              console.log('Analysis successful with', analysis.suggestedFixes.length, 'suggested fixes');
              
              // Save analysis for reference
              const analysisPath = path.join(__dirname, 'analysis', `analysis-${Date.now()}.json`);
              fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
              
              // Get the highest confidence fix
              const bestFix = analysis.suggestedFixes[0];
              
              // Ensure octokit is initialized before using it
              if (!octokit) {
                console.error('Octokit not initialized yet');
                return;
              }
              
              // Post analysis as comment
              await octokit.issues.createComment({
                owner: repo.owner.login,
                repo: repo.name,
                issue_number: issue.number,
                body: `### 🛠️ Error Analysis\n\n` +
                      `**Error:** \`${errorDetails.error}\`\n` +
                      `**Root Cause:** ${analysis.aiAnalysis.rootCause}\n` +
                      `**Confidence:** ${(bestFix.confidence * 100).toFixed(1)}%\n` +
                      `**Source:** ${bestFix.source}\n\n` +
                      `**Context:** Analyzed ${analysis.context?.split('===').length - 1 || 1} files\n\n` +
                      `**Suggested Fix:**\n\`\`\`${bestFix.code}\`\`\`\n\n` +
                      `**Explanation:** ${bestFix.explanation || analysis.aiAnalysis.rootCause}\n\n` +
                      `**Test Impact:** ${analysis.aiAnalysis.testImpact}\n\n` +
                      (analysis.aiAnalysis.alternatives ? `**Alternative Solutions:**\n${analysis.aiAnalysis.alternatives}\n\n` : '') +
                      `Analysis saved at: \`${analysisPath}\``
              });

              // Apply the fix if confidence is high enough
              if (bestFix.confidence >= 0.8) {
                const fixApplied = await errorAnalysis.applyFix(
                  path.join(repoPath, errorDetails.file),
                  bestFix
                );

                if (fixApplied) {
                  // Create PR with the fix
                  // ... existing PR creation logic ...
                }
              }
            } else {
              console.log('No fixes suggested');
              
              // Ensure octokit is initialized before using it
              if (!octokit) {
                console.error('Octokit not initialized yet');
                return;
              }
              
              await octokit.issues.createComment({
                owner: repo.owner.login,
                repo: repo.name,
                issue_number: issue.number,
                body: '❌ No automatic fixes could be generated for this error. Please review manually.'
              });
            }
            
            // Clean up: remove temporary repository
            try {
              fs.rmSync(repoPath, { recursive: true, force: true });
              console.log('Temporary repository cleaned up:', repoPath);
            } catch (cleanupError) {
              console.warn('Failed to cleanup temporary repository:', cleanupError.message);
            }
          } catch (error) {
            console.error('Error processing:', error);
            
            // Clean up: remove temporary repository if it exists
            if (typeof repoPath !== 'undefined' && repoPath && fs.existsSync(repoPath)) {
              try {
                fs.rmSync(repoPath, { recursive: true, force: true });
                console.log('Temporary repository cleaned up after error:', repoPath);
              } catch (cleanupError) {
                console.warn('Failed to cleanup temporary repository after error:', cleanupError.message);
              }
            }
            
            // Ensure octokit is initialized before using it
            if (!octokit) {
              console.error('Octokit not initialized yet');
              return;
            }
            
            await octokit.issues.createComment({
              owner: repo.owner.login,
              repo: repo.name,
              issue_number: issue.number,
              body: `❌ Error processing the issue: ${error.message}`
            });
          }
        }
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
    }
  })();
}); // Close the webhook handler

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at: http://0.0.0.0:${PORT}/health`);
  console.log(`Webhook endpoint available at: http://0.0.0.0:${PORT}/webhook`);
}); 