# Render + GitHub Integration Setup Guide

## 🚀 Setting Up Render Backend to Connect with GitHub

This guide helps you configure your Render Node.js backend to properly connect to GitHub and make changes to repositories.

## 📋 Prerequisites

1. **Valid GitHub Token** (expires Aug 3, 2025)
2. **Repository Access** to `5x-Platform/5x-platform-nextgen-ui`
3. **Render Account** with deployed service

## 🔧 Step-by-Step Setup

### Step 1: Verify GitHub Token Permissions

Your token needs these specific permissions:

- **`repo`** - Full control of private repositories
  - Required for: Cloning repositories, pushing branches, creating PRs
- **`issues`** - Read and write access to issues
  - Required for: Reading issue details, posting comments
- **`pull_requests`** - Read and write access to pull requests
  - Required for: Creating pull requests

### Step 2: Configure Render Environment Variables

1. **Go to Render Dashboard**
   - Visit: https://dashboard.render.com
   - Find your Sentry Bot service

2. **Set Environment Variables**
   - Click on your service
   - Go to **Environment** tab
   - Click **Environment Variables**
   - Add/update these variables:

```bash
GITHUB_TOKEN=ghp_your_valid_token_here
OPENAI_API_KEY=sk-your_openai_key_here
SENTRY_API_TOKEN=sntryu_your_sentry_token_here
PORT=10000
NODE_ENV=production
```

### Step 3: Test Repository Access

Run the repository access test:

```bash
npm run test-repo
```

Expected output:
```
✅ Authenticated as: your_username
✅ Repository access successful!
✅ Branch access successful!
✅ Issue access successful!
✅ Pull request access successful!
🎉 All tests passed!
```

### Step 4: Verify Render Deployment

1. **Check Render Logs**
   - Go to your service in Render dashboard
   - Click **Logs** tab
   - Look for these success messages:
   ```
   ✅ GitHub API authentication successful
   ✅ All required environment variables are set
   🚀 Server is running on port 10000
   ```

2. **Test Health Endpoint**
   ```bash
   curl https://your-render-app.onrender.com/health
   ```

## 🔍 Troubleshooting

### Common Issues and Solutions

#### 1. "Bad credentials" (401)
**Cause**: Invalid or expired token
**Solution**: 
- Generate new token at https://github.com/settings/tokens
- Update `GITHUB_TOKEN` in Render environment variables

#### 2. "Repository not found" (404)
**Cause**: Token lacks repository access
**Solution**:
- Ensure token owner has access to `5x-Platform/5x-platform-nextgen-ui`
- Check if repository is private and token owner is a member

#### 3. "Insufficient permissions" (403)
**Cause**: Token missing required scopes
**Solution**:
- Regenerate token with `repo`, `issues`, `pull_requests` permissions
- Update environment variables in Render

#### 4. "could not read Username for 'https://github.com'"
**Cause**: Git authentication issue
**Solution**:
- Verify token format (should start with `ghp_`)
- Check if token has `repo` permissions
- Ensure no extra spaces in environment variable

### Testing Commands

```bash
# Test environment variables
npm run check-env

# Test repository access
npm run test-repo

# Test health endpoint
curl https://your-render-app.onrender.com/health
```

## 🎯 Expected Behavior

Once properly configured, your Render backend should:

✅ **Clone repositories** without authentication errors
✅ **Create branches** from staging
✅ **Apply AI-generated fixes** to code
✅ **Commit and push changes** to new branches
✅ **Create pull requests** to dev branch
✅ **Post comments** on GitHub issues with PR links

## 📊 Monitoring

### Check Render Logs
- Go to your service in Render dashboard
- Click **Logs** tab
- Look for authentication success messages

### Monitor GitHub Activity
- Check the target repository for new branches
- Look for pull requests created by the bot
- Monitor issue comments for bot responses

## 🔐 Security Best Practices

1. **Use Environment Variables**: Never hardcode tokens
2. **Rotate Tokens**: Generate new tokens periodically
3. **Minimize Permissions**: Only grant necessary scopes
4. **Monitor Usage**: Check GitHub token usage in settings
5. **Use Fine-Grained Tokens**: For better security control

## 📞 Need Help?

If you're still having issues:

1. Run `npm run test-repo` and share the output
2. Check Render logs for specific error messages
3. Verify token permissions in GitHub settings
4. Ensure repository access for the token owner
5. Test with a fresh token if needed 