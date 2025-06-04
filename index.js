require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Helper to parse Sentry details from issue body
function parseSentryDetails(body) {
  // Example: extract file, line, and error message from a typical Sentry stack trace
  // This is a simple regex and may need adjustment for your real Sentry format
  const fileMatch = body.match(/File:\s*(.*)/);
  const lineMatch = body.match(/Line:\s*(\d+)/);
  const errorMatch = body.match(/Error:\s*([\s\S]*)/);
  return {
    file: fileMatch ? fileMatch[1].trim() : null,
    line: lineMatch ? parseInt(lineMatch[1], 10) : null,
    error: errorMatch ? errorMatch[1].trim() : null,
  };
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  if (event === 'issues' && req.body.action === 'opened') {
    const issue = req.body.issue;
    const repo = req.body.repository;
    const labels = issue.labels.map(label => label.name);
    if (labels.includes('sentry error')) {
      console.log('Received new Sentry error issue:', issue.title);
      const sentryDetails = parseSentryDetails(issue.body);
      const repoOwner = repo.owner.login;
      const repoName = repo.name;
      const repoUrl = repo.clone_url;
      const branchName = `sentry-fix-${Date.now()}`;
      const localPath = path.join(__dirname, 'tmp', `${repoOwner}-${repoName}-${Date.now()}`);
      const git = simpleGit();
      const remoteWithToken = repoUrl.replace('https://', `https://${process.env.GITHUB_TOKEN}@`);
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
    }
  }
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 