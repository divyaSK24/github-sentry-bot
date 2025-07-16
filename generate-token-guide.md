# GitHub Token Generation Guide

## 🔧 Quick Fix for Authentication Issues

Your current GitHub token appears to be invalid or expired. Follow these steps to generate a new one:

### Step 1: Generate New Token

1. **Go to GitHub Token Settings**
   - Visit: https://github.com/settings/tokens
   - Click "Generate new token (classic)"

2. **Configure Token Settings**
   - **Note**: `Sentry Bot Token`
   - **Expiration**: `No expiration` (or set a long period)
   - **Scopes**: Select these permissions:
     - ✅ `repo` (Full control of private repositories)
     - ✅ `issues` (Read and write access to issues)
     - ✅ `pull_requests` (Read and write access to pull requests)

3. **Generate and Copy Token**
   - Click "Generate token"
   - **IMPORTANT**: Copy the token immediately (starts with `ghp_`)

### Step 2: Update Environment Variables

#### For Render Deployment:
1. Go to your Render dashboard
2. Navigate to your service
3. Go to Environment → Environment Variables
4. Update `GITHUB_TOKEN` with the new token value

#### For Local Development:
Create/update `.env` file:
```bash
GITHUB_TOKEN=ghp_your_new_token_here
OPENAI_API_KEY=sk-your_openai_key_here
SENTRY_API_TOKEN=sntryu_your_sentry_token_here
PORT=10000
```

### Step 3: Test Configuration

Run the environment check:
```bash
npm run check-env
```

Expected output:
```
✅ GitHub authentication successful!
   Authenticated as: your_username
   User ID: 123456
```

### Step 4: Deploy/Restart

- **Render**: The service will automatically restart
- **Local**: Restart your server with `npm start`

## 🔍 Troubleshooting

### If you still get authentication errors:

1. **Check token format**: Should start with `ghp_`
2. **Verify permissions**: Token needs `repo`, `issues`, `pull_requests`
3. **Check expiration**: Make sure token hasn't expired
4. **Repository access**: Ensure token owner has access to the repository

### Common Issues:

- **"Bad credentials"**: Token is invalid/expired → Generate new token
- **"Repository not found"**: Token lacks repository access → Check permissions
- **"Rate limit exceeded"**: Too many API calls → Wait or use different token

## 📞 Need Help?

1. Run `npm run check-env` and share the output
2. Check token permissions in GitHub settings
3. Verify repository access with your GitHub account
4. Check deployment platform logs for additional details 