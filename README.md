# GitHub Sentry Bot

A bot that automatically analyzes Sentry errors and suggests fixes for GitHub issues.

## Features

- Automatically processes GitHub issues with "sentry error" label
- Fetches Sentry event data and analyzes errors
- Suggests fixes using AI analysis
- Posts analysis results as GitHub comments

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

# Bito Configuration (optional)
BITO_API_KEY=your_bito_api_key_here
```

## Deployment

The application is configured to work with most deployment platforms:

1. **Start Script**: Uses `npm start` to run the application
2. **Port Binding**: Binds to `0.0.0.0` on the specified port (default: 10000)
3. **Health Check**: Available at `/health` endpoint
4. **Procfile**: Included for Heroku and similar platforms

## API Endpoints

- `GET /` - Basic info about the service
- `GET /health` - Health check endpoint
- `POST /webhook` - GitHub webhook endpoint

## Setup

1. Install dependencies: `npm install`
2. Set environment variables
3. Start the server: `npm start`

The bot will automatically process GitHub issues when the "sentry error" label is added. 