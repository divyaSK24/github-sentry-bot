#!/usr/bin/env node

require('dotenv').config();

console.log('🔍 Testing Public Repository Access\n');

async function testPublicRepository() {
  try {
    const { Octokit } = await import('@octokit/rest');
    
    if (!process.env.GITHUB_TOKEN) {
      console.error('❌ GITHUB_TOKEN environment variable is not set');
      return;
    }
    
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
    
    // Test with a public repository
    console.log('🔐 Testing GitHub Authentication...');
    const user = await octokit.rest.users.getAuthenticated();
    console.log(`✅ Authenticated as: ${user.data.login}`);
    
    // Test with a public repository
    console.log('\n📁 Testing Public Repository Access...');
    try {
      const repo = await octokit.rest.repos.get({
        owner: 'facebook',
        repo: 'react'
      });
      console.log(`✅ Public repository access successful!`);
      console.log(`   Repository: ${repo.data.full_name}`);
      console.log(`   Visibility: ${repo.data.visibility}`);
      
      // Test branch access
      console.log('\n🌿 Testing Branch Access...');
      const branches = await octokit.rest.repos.listBranches({
        owner: 'facebook',
        repo: 'react'
      });
      console.log(`✅ Branch access successful!`);
      console.log(`   Available branches: ${branches.data.slice(0, 5).map(b => b.name).join(', ')}...`);
      
      console.log('\n🎉 Token is working correctly!');
      console.log('   The issue is specifically with access to 5x-Platform/5x-platform-nextgen-ui');
      console.log('   This suggests the repository is private and your account lacks access.');
      
    } catch (repoError) {
      console.error(`❌ Even public repository access failed: ${repoError.message}`);
    }
    
  } catch (error) {
    console.error(`❌ Authentication failed: ${error.message}`);
  }
}

testPublicRepository(); 