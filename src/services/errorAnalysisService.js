const { execSync } = require('child_process');
const OpenAI = require('openai');
const ContextBuilder = require('../utils/contextBuilder');
const path = require('path');
const fs = require('fs');
const diff = require('diff');

class ErrorAnalysisService {
  constructor(options = {}) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.contextBuilder = new ContextBuilder(options.maxTokens);
  }

  async analyzeError(errorDetails, repoPath) {
    const results = {
      aiAnalysis: null,
      suggestedFixes: []
    };

    try {
      // 1. Build context for AI analysis
      const context = await this.contextBuilder.buildContext(
        path.join(repoPath, errorDetails.file),
        errorDetails.line,
        repoPath
      );

      // 2. Run AI analysis
      results.aiAnalysis = await this.runAIAnalysis(errorDetails, context);

      // 3. Combine and prioritize fixes
      results.suggestedFixes = this.combineFixes(results);

      return results;
    } catch (error) {
      console.error('Error in analysis:', error);
      throw error;
    }
  }

  async runAIAnalysis(errorDetails, context) {
    const prompt = this.buildAnalysisPrompt(errorDetails, context);
    
    const response = await this.openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert at analyzing and fixing code errors. Provide detailed analysis and fixes."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3
    });

    return this.parseAIResponse(response.choices[0].message.content);
  }

  buildAnalysisPrompt(errorDetails, context) {
    return `A Sentry error was reported in our application:
Error Type: ${errorDetails.errorType}
Error Message: ${errorDetails.error}

Primary Error Location:
File: ${errorDetails.file}
Line: ${errorDetails.line}

Context:
${context}

Please analyze the error and suggest a fix. Focus on the primary error location. The fix should:
1. Address the root cause of the error
2. Handle any edge cases
3. Include appropriate error handling
4. Add a comment explaining the fix

Provide the fix in a code block.`;
  }

  parseAIResponse(response) {
    console.log('🤖 Raw AI Response:', response);
    
    // Extract code block using the working regex from backup
    const codeBlockMatch = response.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    let suggestedFix = '';
    
    if (codeBlockMatch) {
      suggestedFix = codeBlockMatch[1].trim();
      console.log('✅ Extracted code block:', suggestedFix);
    } else {
      console.log('⚠️  No code block found in response');
      suggestedFix = response.trim();
    }
    
    return {
      rootCause: 'AI Analysis',
      suggestedFix: suggestedFix,
      testImpact: 'Unknown',
      confidence: 0.8,
      alternatives: ''
    };
  }

  combineFixes(results) {
    const fixes = [];

    // Add AI fixes
    if (results.aiAnalysis?.suggestedFix) {
      fixes.push({
        type: 'ai',
        code: results.aiAnalysis.suggestedFix,
        confidence: results.aiAnalysis.confidence,
        source: 'OpenAI',
        explanation: results.aiAnalysis.rootCause
      });
    }

    // Sort by confidence
    return fixes.sort((a, b) => b.confidence - a.confidence);
  }

  async applyFix(filePath, fix) {
    try {
      console.log('🔧 Applying fix to file:', filePath);

      // Validate file path - don't try to fix files in node_modules
      if (filePath.includes('node_modules/')) {
        console.warn('⚠️  Skipping fix for node_modules file:', filePath);
        return {
          success: false,
          reason: 'Cannot apply fixes to files in node_modules'
        };
      }

      // Skip build files and generated assets
      if (this.shouldSkipFile(filePath)) {
        console.warn('⚠️  Skipping fix for build/generated file:', filePath);
        return {
          success: false,
          reason: 'Cannot apply fixes to build files or generated assets'
        };
      }

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.warn('⚠️  File does not exist:', filePath);
        
        // Try to find the correct file path
        const alternativePath = this.findAlternativeFilePath(filePath);
        if (alternativePath && fs.existsSync(alternativePath)) {
          console.log('📍 Found alternative file path:', alternativePath);
          return this.applyFix(alternativePath, fix);
        }
        
        return {
          success: false,
          reason: `File not found: ${filePath}`
        };
      }

      // Read the file content
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      // Get the AI fix code
      const aiFix = fix.code;
      console.log('🤖 AI Fix:', aiFix);
      
      // Apply the fix to the specific block around the error line
      const errorLine = fix.errorLine || 1;
      const startLine = Math.max(0, errorLine - 5);
      const endLine = Math.min(lines.length, errorLine + 5);
      const originalBlock = lines.slice(startLine, endLine).join('\n');
      
      console.log('📍 Original block (lines', startLine + 1, 'to', endLine, '):', originalBlock);
      
      // Compare the original block with the AI fix using diff
      const changes = diff.diffLines(originalBlock, aiFix);
      const hasMeaningfulChange = changes.some(change =>
        (change.added || change.removed) &&
        change.value.replace(/\s/g, '').length > 0
      );
      
      console.log('🔍 Has meaningful change:', hasMeaningfulChange);
      
      if (hasMeaningfulChange) {
        // Replace the block in the file content
        const newLines = [...lines];
        newLines.splice(startLine, endLine - startLine, ...aiFix.split('\n'));
      
        // Write the updated content back to the file
        fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
        console.log('✅ AI fix applied successfully to file:', filePath);
      
      return {
        success: true,
          diff: changes,
          location: { startLine, endLine }
        };
      } else {
        console.log('⚠️  AI fix is not meaningful or is destructive. Skipping file update.');
        return {
          success: false,
          reason: 'No meaningful changes detected'
        };
      }
    } catch (error) {
      console.error('❌ Error applying fix:', error);
      return {
        success: false,
        reason: error.message
      };
    }
  }

  shouldSkipFile(filePath) {
    const skipPatterns = [
      // Build directories
      /_next\//,
      /dist\//,
      /build\//,
      /\.next\//,
      /out\//,
      
      // Generated files
      /\.min\.(js|css)$/,
      /\.bundle\.(js|css)$/,
      /\.chunk\.(js|css)$/,
      /\.hash\.[a-f0-9]+\.(js|css)$/,
      
      // Static assets
      /static\//,
      /assets\//,
      /public\//,
      
      // Cache and temp files
      /\.cache\//,
      /\.tmp\//,
      /\.temp\//,
      
      // Package files
      /package-lock\.json$/,
      /yarn\.lock$/,
      /pnpm-lock\.yaml$/,
      
      // Config files that shouldn't be modified
      /\.env$/,
      /\.env\./,
      /\.gitignore$/,
      /\.eslintrc/,
      /\.prettierrc/,
      /tsconfig\.json$/,
      /webpack\.config\./,
      /next\.config\./,
      /vite\.config\./,
      
      // Generated documentation
      /README\.md$/,
      /CHANGELOG\.md$/,
      /LICENSE$/,
      
      // Binary files
      /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz)$/,
      
      // Lock files
      /\.lock$/,
      
      // IDE files
      /\.vscode\//,
      /\.idea\//,
      /\.DS_Store$/,
      
      // Test files (usually shouldn't be auto-fixed)
      /\.test\.(js|ts|jsx|tsx)$/,
      /\.spec\.(js|ts|jsx|tsx)$/,
      /__tests__\//,
      /test\//,
      /tests\//,
      
      // Generated TypeScript declaration files
      /\.d\.ts$/,
      
      // Generated CSS files
      /\.css$/,
      /\.scss$/,
      /\.sass$/,
      /\.less$/,
      
      // Generated HTML files
      /\.html$/,
      
      // Generated JSON files (except package.json)
      /\.json$/,
      
      // Generated YAML files
      /\.yml$/,
      /\.yaml$/
    ];

    for (const pattern of skipPatterns) {
      if (pattern.test(filePath)) {
        console.log(`⏭️  Skipping file due to pattern: ${pattern}`);
        return true;
      }
    }

    return false;
  }

  findAlternativeFilePath(originalPath) {
    try {
      // Extract the file name and extension
      const fileName = path.basename(originalPath);
      const fileExt = path.extname(fileName);
      const fileNameWithoutExt = path.basename(fileName, fileExt);
      
      // Common alternative locations to check
      const alternatives = [
        // Remove node_modules prefix if present
        originalPath.replace(/.*node_modules[\/\\]/, ''),
        // Try src/ directory
        path.join('src', fileName),
        // Try components/ directory
        path.join('src', 'components', fileName),
        // Try pages/ directory
        path.join('src', 'pages', fileName),
        // Try utils/ directory
        path.join('src', 'utils', fileName),
        // Try services/ directory
        path.join('src', 'services', fileName),
        // Try root directory
        fileName,
        // Try with .js extension
        fileNameWithoutExt + '.js',
        // Try with .ts extension
        fileNameWithoutExt + '.ts',
        // Try with .tsx extension
        fileNameWithoutExt + '.tsx',
        // Try with .jsx extension
        fileNameWithoutExt + '.jsx'
      ];

      // Check each alternative
      for (const altPath of alternatives) {
        if (fs.existsSync(altPath)) {
          console.log('✅ Found alternative file:', altPath);
          return altPath;
        }
      }

      // If no exact match, try to find files with similar names
      const searchPattern = `**/${fileNameWithoutExt}*${fileExt}`;
      const glob = require('glob');
      const matches = glob.sync(searchPattern, { 
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
        absolute: true 
      });

      if (matches.length > 0) {
        console.log('✅ Found similar file:', matches[0]);
        return matches[0];
      }

    } catch (error) {
      console.warn('Error finding alternative file path:', error.message);
    }

    return null;
  }

  checkForCommonIssues(content) {
    // Simple validation - just check for obvious issues
    const issues = [];
    
    if (content.includes('undefinedundefined')) {
      issues.push('Potential undefined concatenation');
    }
    
    if (content.includes('nullnull')) {
      issues.push('Potential null concatenation');
    }
    
    return issues;
  }
}

module.exports = ErrorAnalysisService; 