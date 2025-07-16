# Authentication Troubleshooting Guide

## GitHub Token Issues

### Error: "could not read Username for 'https://github.com'"
This error occurs when the bot tries to clone a repository but the GitHub token is invalid or missing.

### Error: "Bad credentials" (401)
This error occurs when the GitHub API rejects the token due to:
- Invalid token
- Expired token
- Insufficient permissions

## Solutions

### 1. Generate a New GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a descriptive name like "Sentry Bot"
4. Set expiration to "No expiration" or a long period
5. Select the following scopes:
   - `repo` (Full control of private repositories)
   - `issues` (Read and write access to issues)
   - `pull_requests` (Read and write access to pull requests)
6. Click "Generate token"
7. Copy the token immediately (you won't see it again)

### 2. Update Your Environment Variables

#### For Local Development
Create a `.env` file in your project root:
```bash
GITHUB_TOKEN=ghp_your_new_token_here
OPENAI_API_KEY=sk-your_openai_key_here
SENTRY_API_TOKEN=sntryu_your_sentry_token_here
PORT=10000
```

#### For Deployment Platforms

**Render:**
1. Go to your service dashboard
2. Navigate to Environment → Environment Variables
3. Add/update the `GITHUB_TOKEN` variable

**Heroku:**
```bash
heroku config:set GITHUB_TOKEN=ghp_your_new_token_here
```

**Railway:**
1. Go to your project dashboard
2. Navigate to Variables
3. Add/update the `GITHUB_TOKEN` variable

### 3. Test Your Configuration

Run the environment check script:
```bash
npm run check-env
```

Expected output:
```
✅ GitHub authentication successful!
   Authenticated as: your_username
   User ID: 123456
```

### 4. Verify Token Permissions

Your token needs these specific permissions:

- **repo** - Full control of private repositories
  - Required for: Cloning repositories, pushing branches, creating PRs
- **issues** - Read and write access to issues
  - Required for: Reading issue details, posting comments
- **pull_requests** - Read and write access to pull requests
  - Required for: Creating pull requests

### 5. Check Repository Access

Ensure your token has access to the target repository:
- For public repositories: Any valid token should work
- For private repositories: The token owner must have access to the repository

### 6. Common Token Issues

#### Token Format
- GitHub tokens start with `ghp_` (for classic tokens) or `gho_` (for fine-grained tokens)
- Make sure the token is not truncated or has extra spaces

#### Token Expiration
- Classic tokens can be set to never expire
- Fine-grained tokens have a maximum expiration of 1 year
- Check if your token has expired

#### Organization Access
- If the repository belongs to an organization, ensure the token owner has access
- The token owner must be a member of the organization

## Testing Your Setup

### 1. Local Testing
```bash
# Install dependencies
npm install

# Check environment
npm run check-env

# Start the server
npm start
```

### 2. Test Webhook Endpoint
```bash
curl -X POST http://localhost:10000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -d '{"test": "data"}'
```

### 3. Test Health Endpoint
```bash
curl http://localhost:10000/health
```

## Debugging Commands

### Check Environment Variables
```bash
# Check if variables are loaded
node -e "require('dotenv').config(); console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? 'Set' : 'Not set')"
```

### Test GitHub API Directly
```bash
curl -H "Authorization: token YOUR_TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     https://api.github.com/user
```

### Test Repository Access
```bash
curl -H "Authorization: token YOUR_TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     https://api.github.com/repos/OWNER/REPO
```

## Error Messages and Solutions

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `could not read Username for 'https://github.com'` | Invalid token in git clone | Generate new token with repo permissions |
| `Bad credentials` | Invalid/expired token | Generate new token |
| `Not Found` | Repository access denied | Check repository permissions |
| `Rate limit exceeded` | Too many API calls | Wait or use different token |
| `Forbidden` | Insufficient permissions | Add required scopes to token |

## Security Best Practices

1. **Use Environment Variables**: Never hardcode tokens in your code
2. **Rotate Tokens Regularly**: Generate new tokens periodically
3. **Minimize Permissions**: Only grant the permissions you need
4. **Monitor Usage**: Check GitHub's token usage in settings
5. **Use Fine-Grained Tokens**: For better security, use fine-grained tokens instead of classic tokens

## Getting Help

If you're still having issues:

1. Run `npm run check-env` and share the output
2. Check the GitHub token permissions in your GitHub settings
3. Verify the repository is accessible with your GitHub account
4. Check the deployment platform logs for additional error details 