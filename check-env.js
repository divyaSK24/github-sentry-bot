#!/usr/bin/env node

require('dotenv').config();

console.log('🔍 Environment Variable Check\n');

// Check required environment variables
const requiredEnvVars = {
  'GITHUB_TOKEN': process.env.GITHUB_TOKEN,
  'OPENAI_API_KEY': process.env.OPENAI_API_KEY,
  'SENTRY_API_TOKEN': process.env.SENTRY_API_TOKEN
};

let allSet = true;

console.log('Required Environment Variables:');
for (const [varName, value] of Object.entries(requiredEnvVars)) {
  if (value) {
    console.log(`✅ ${varName}: Set (${value.substring(0, 8)}...)`);
  } else {
    console.log(`❌ ${varName}: Not set`);
    allSet = false;
  }
}

console.log('\n' + '='.repeat(50));

if (!allSet) {
  console.log('\n❌ Some required environment variables are missing.');
  console.log('Please set the missing variables and try again.');
  process.exit(1);
}

console.log('\n✅ All required environment variables are set!');

// Test GitHub authentication
console.log('\n🔐 Testing GitHub Authentication...');

(async () => {
  try {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
    
    const user = await octokit.rest.users.getAuthenticated();
    console.log(`✅ GitHub authentication successful!`);
    console.log(`   Authenticated as: ${user.data.login}`);
    console.log(`   User ID: ${user.data.id}`);
    
    // Test repository access
    console.log('\n🔍 Testing Repository Access...');
    try {
      const repo = await octokit.rest.repos.get({
        owner: '5x-Platform',
        repo: '5x-platform-nextgen-ui'
      });
      console.log(`✅ Repository access successful!`);
      console.log(`   Repository: ${repo.data.full_name}`);
      console.log(`   Visibility: ${repo.data.visibility}`);
    } catch (repoError) {
      console.log(`⚠️  Repository access failed: ${repoError.message}`);
      if (repoError.status === 404) {
        console.log('   This might be a private repository or the token lacks access.');
      }
    }
    
  } catch (error) {
    console.log(`❌ GitHub authentication failed: ${error.message}`);
    if (error.status === 401) {
      console.log('   The GITHUB_TOKEN appears to be invalid or expired.');
      console.log('   Please check your token and ensure it has the necessary permissions.');
    }
    process.exit(1);
  }
})();

// Test OpenAI API
console.log('\n🤖 Testing OpenAI API...');

(async () => {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Hello! This is a test message."
        }
      ],
      max_tokens: 10
    });
    
    console.log(`✅ OpenAI API test successful!`);
    console.log(`   Response received: ${response.choices[0].message.content}`);
    
  } catch (error) {
    console.log(`❌ OpenAI API test failed: ${error.message}`);
    if (error.status === 401) {
      console.log('   The OPENAI_API_KEY appears to be invalid.');
    }
  }
})();

// Test Sentry API
console.log('\n📊 Testing Sentry API...');

(async () => {
  try {
    const response = await fetch('https://sentry.io/api/0/', {
      headers: {
        'Authorization': `Bearer ${process.env.SENTRY_API_TOKEN}`
      }
    });
    
    if (response.ok) {
      console.log(`✅ Sentry API test successful!`);
      console.log(`   Status: ${response.status}`);
    } else {
      console.log(`⚠️  Sentry API test returned status: ${response.status}`);
      console.log(`   This might be normal if the endpoint requires specific parameters.`);
    }
    
  } catch (error) {
    console.log(`❌ Sentry API test failed: ${error.message}`);
  }
})();

console.log('\n' + '='.repeat(50));
console.log('\n📋 Summary:');
console.log('If all tests pass, your environment is properly configured!');
console.log('If any tests fail, please check the corresponding API keys and permissions.'); 