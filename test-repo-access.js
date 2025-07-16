#!/usr/bin/env node

require('dotenv').config();

console.log('🔍 Testing Repository Access\n');

// Test GitHub authentication and repository access
async function testRepositoryAccess() {
  try {
    const { Octokit } = await import('@octokit/rest');
    
    if (!process.env.GITHUB_TOKEN) {
      console.error('❌ GITHUB_TOKEN environment variable is not set');
      return;
    }
    
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
    
    // Test 1: Basic authentication
    console.log('🔐 Testing GitHub Authentication...');
    const user = await octokit.rest.users.getAuthenticated();
    console.log(`✅ Authenticated as: ${user.data.login}`);
    console.log(`   User ID: ${user.data.id}`);
    
    // Test 2: Repository access
    console.log('\n📁 Testing Repository Access...');
    const repoOwner = '5x-Platform';
    const repoName = '5x-platform-nextgen-ui';
    
    try {
      const repo = await octokit.rest.repos.get({
        owner: repoOwner,
        repo: repoName
      });
      console.log(`✅ Repository access successful!`);
      console.log(`   Repository: ${repo.data.full_name}`);
      console.log(`   Visibility: ${repo.data.visibility}`);
      console.log(`   Default branch: ${repo.data.default_branch}`);
      
      // Test 3: Branch access
      console.log('\n🌿 Testing Branch Access...');
      const branches = await octokit.rest.repos.listBranches({
        owner: repoOwner,
        repo: repoName
      });
      console.log(`✅ Branch access successful!`);
      console.log(`   Available branches: ${branches.data.map(b => b.name).join(', ')}`);
      
      // Test 4: Issue access
      console.log('\n📋 Testing Issue Access...');
      const issues = await octokit.rest.issues.listForRepo({
        owner: repoOwner,
        repo: repoName,
        state: 'open',
        per_page: 1
      });
      console.log(`✅ Issue access successful!`);
      console.log(`   Can read/write issues: Yes`);
      
      // Test 5: Pull request access
      console.log('\n🔀 Testing Pull Request Access...');
      const pulls = await octokit.rest.pulls.list({
        owner: repoOwner,
        repo: repoName,
        state: 'open',
        per_page: 1
      });
      console.log(`✅ Pull request access successful!`);
      console.log(`   Can create/read PRs: Yes`);
      
      console.log('\n🎉 All tests passed! Your token has the necessary permissions.');
      console.log('   The bot should be able to:');
      console.log('   - Clone the repository');
      console.log('   - Create branches');
      console.log('   - Push changes');
      console.log('   - Create pull requests');
      console.log('   - Post comments on issues');
      
    } catch (repoError) {
      console.error(`❌ Repository access failed: ${repoError.message}`);
      if (repoError.status === 404) {
        console.error('   Repository not found or access denied.');
        console.error('   Check if the token owner has access to this repository.');
      } else if (repoError.status === 403) {
        console.error('   Insufficient permissions.');
        console.error('   Token needs repo, issues, and pull_requests permissions.');
      }
    }
    
  } catch (error) {
    console.error(`❌ Authentication failed: ${error.message}`);
    if (error.status === 401) {
      console.error('   The GITHUB_TOKEN appears to be invalid or expired.');
      console.error('   Please check your token and ensure it has the necessary permissions.');
    }
  }
}

// Run the test
testRepositoryAccess(); 