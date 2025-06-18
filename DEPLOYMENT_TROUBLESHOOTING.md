# Deployment Troubleshooting Guide

## 502 Error Solutions

### 1. Check Environment Variables
Make sure these are set in your deployment platform:
```bash
GITHUB_TOKEN=your_github_token_here
OPENAI_API_KEY=your_openai_api_key_here
SENTRY_API_TOKEN=your_sentry_api_token_here
PORT=10000
```

### 2. Check Port Configuration
- Ensure your deployment platform is configured to use port 10000
- The bot binds to `0.0.0.0:10000` for external access

### 3. Check Startup Logs
Look for these messages in your deployment logs:
```
🚀 Server is running on port 10000
📍 Health check available at: http://0.0.0.0:10000/health
🔗 Webhook endpoint available at: http://0.0.0.0:10000/webhook
✅ All required environment variables are set
```

### 4. Test Health Endpoint
Once deployed, test the health endpoint:
```bash
curl https://your-app-url/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2025-06-18T10:00:51.562Z",
  "port": 10000,
  "uptime": 123.45,
  "memory": {
    "used": 45,
    "total": 67,
    "external": 12
  },
  "environment": "production",
  "nodeVersion": "v20.9.0",
  "platform": "linux",
  "envVars": {
    "githubToken": true,
    "openaiApiKey": true,
    "sentryApiToken": true
  }
}
```

### 5. Common Issues

#### Missing Environment Variables
If you see warnings like:
```
⚠️  Missing environment variables: GITHUB_TOKEN, OPENAI_API_KEY
```
Set the missing variables in your deployment platform.

#### Memory Issues
If memory usage is high, consider:
- Increasing memory allocation
- Optimizing the analysis process

#### Startup Timeout
If the bot takes too long to start:
- Check for network connectivity issues
- Verify all dependencies are installed
- Look for blocking operations during startup

### 6. Local Testing
Test locally before deploying:
```bash
npm start
curl http://localhost:10000/health
```

### 7. Deployment Platform Specific

#### Render
- Set build command: `npm install`
- Set start command: `npm start`
- Set environment variables in the dashboard

#### Heroku
- Ensure Procfile contains: `web: npm start`
- Set environment variables in dashboard

#### Railway
- Set start command: `npm start`
- Configure environment variables

### 8. Debugging Commands
```bash
# Check if server is responding
curl -v https://your-app-url/health

# Test webhook endpoint (should return 200 OK)
curl -X POST https://your-app-url/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'

# Check server logs for errors
# Look for: 💥 Uncaught Exception or 💥 Unhandled Rejection
```

### 9. Contact Support
If issues persist:
1. Check deployment platform logs
2. Verify all environment variables are set
3. Test health endpoint
4. Review startup logs for errors 