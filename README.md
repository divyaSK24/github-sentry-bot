# GitHub Sentry Bot

A bot that automatically analyzes Sentry errors and suggests fixes for GitHub issues.

## Features

- Automatically processes GitHub issues with "sentry error" label
- Fetches Sentry event data and analyzes errors
- Suggests fixes using AI analysis
- Applies fixes to a temporary repository
- Creates branches, commits, and pushes changes
- Creates pull requests to the dev branch
- Posts analysis results and PR links as GitHub comments

## Environment Variables

Set these environment variables in your deployment platform:

```bash
# Server Configuration
PORT=10000

# GitHub Configuration
GITHUB_TOKEN=your_github_personal_access_token_here

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Sentry Configuration
SENTRY_API_TOKEN=your_sentry_api_token_here
```

## GitHub Token Requirements

Your `GITHUB_TOKEN` must have the following permissions:
- `repo` - Full control of private repositories
- `issues` - Read and write access to issues
- `pull_requests` - Read and write access to pull requests

## Setup

1. Install dependencies: `npm install`
2. Set environment variables
3. Test your configuration: `npm run check-env`
4. Start the server: `npm start`

## API Endpoints

- `GET /` - Basic info about the service
- `GET /health` - Health check endpoint
- `POST /webhook` - GitHub webhook endpoint

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:

1. **Check environment variables**: Run `npm run check-env` to verify all variables are set
2. **Verify GitHub token**: Ensure your token has the required permissions
3. **Check token format**: Make sure the token is not truncated or malformed

### Common Error Messages

- `"could not read Username for 'https://github.com'"` - GitHub token authentication issue
- `"Bad credentials"` - Invalid or expired GitHub token
- `"GitHub authentication failed"` - Token lacks required permissions

The bot will automatically process GitHub issues when the "sentry error" label is added. 