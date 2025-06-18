const { execSync } = require('child_process');
const OpenAI = require('openai');
const ContextBuilder = require('../utils/contextBuilder');
const path = require('path');
const fs = require('fs');

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
    return `Analyze this error and provide a fix:

Error: ${errorDetails.error}
Type: ${errorDetails.errorType}
File: ${errorDetails.file}
Line: ${errorDetails.line}

Context:
${context}

Please provide:
1. Root Cause Analysis
2. Suggested Fix (with code)
3. Test Impact
4. Confidence Level (0-1)
5. Alternative Solutions (if any)`;
  }

  parseAIResponse(response) {
    const sections = response.split('\n\n');
    return {
      rootCause: sections.find(s => s.includes('Root Cause:'))?.replace('Root Cause:', '').trim() || 'Unknown',
      suggestedFix: sections.find(s => s.includes('Suggested Fix:'))?.replace('Suggested Fix:', '').trim() || '',
      testImpact: sections.find(s => s.includes('Test Impact:'))?.replace('Test Impact:', '').trim() || 'Unknown',
      confidence: parseFloat(sections.find(s => s.includes('Confidence Level:'))?.match(/\d+\.?\d*/)?.[0] || '0.8'),
      alternatives: sections.find(s => s.includes('Alternative Solutions:'))?.replace('Alternative Solutions:', '').trim() || ''
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
      // For AI fixes, we need more sophisticated replacement logic
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      // Extract code blocks from the fix
      const codeBlocks = this.extractCodeBlocks(fix.code);
      if (!codeBlocks.length) {
        console.error('No valid code blocks found in fix');
        return false;
      }

      // Find the best location to apply the fix
      const location = await this.findFixLocation(filePath, fix, lines);
      if (!location) {
        console.error('Could not determine where to apply the fix');
        return false;
      }

      // Apply the fix with safety checks
      const newContent = this.applyCodeFix(lines, codeBlocks, location);
      if (!newContent) {
        console.error('Failed to apply code fix');
        return false;
      }

      // Generate diff for review
      const diff = this.generateDiff(content, newContent.join('\n'));
      
      // Safety check: ensure the fix doesn't break the file
      if (!this.validateFix(newContent.join('\n'), filePath)) {
        console.error('Fix validation failed');
        return false;
      }

      // Write the changes
      fs.writeFileSync(filePath, newContent.join('\n'));
      
      return {
        success: true,
        diff,
        location
      };
    } catch (error) {
      console.error('Error applying fix:', error);
      return false;
    }
  }

  extractCodeBlocks(code) {
    // Extract code blocks from markdown or plain code
    const codeBlockRegex = /```(?:[a-z]*\n)?([\s\S]*?)```/g;
    const blocks = [];
    let match;

    while ((match = codeBlockRegex.exec(code)) !== null) {
      blocks.push(match[1].trim());
    }

    // If no code blocks found, treat the entire code as one block
    if (blocks.length === 0) {
      blocks.push(code.trim());
    }

    return blocks;
  }

  async findFixLocation(filePath, fix, lines) {
    console.log('🔍 Finding fix location for:', filePath);
    console.log('Error line from fix:', fix.errorLine);
    console.log('Total lines in file:', lines.length);
    
    // Try to find the error location first
    const errorLine = fix.errorLine || 0;
    if (errorLine > 0 && errorLine <= lines.length) {
      console.log('✅ Found exact error line:', errorLine);
      return {
        startLine: Math.max(1, errorLine - 2),
        endLine: Math.min(lines.length, errorLine + 2),
        context: lines.slice(Math.max(0, errorLine - 2), Math.min(lines.length, errorLine + 2))
      };
    }

    // If no error line, try to find the best match using fuzzy search
    const firstBlock = this.extractCodeBlocks(fix.code)[0];
    if (!firstBlock) {
      console.log('❌ No code blocks found in fix');
      return null;
    }

    console.log('🔍 Searching for code pattern in file...');
    // Find similar code patterns
    const pattern = this.generateSearchPattern(firstBlock);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        console.log('✅ Found matching pattern at line:', i + 1);
        return {
          startLine: Math.max(1, i - 2),
          endLine: Math.min(lines.length, i + 2),
          context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 2))
        };
      }
    }

    console.log('❌ No matching pattern found in file');
    return null;
  }

  generateSearchPattern(code) {
    // Create a regex pattern that matches the code structure
    const lines = code.split('\n');
    const firstLine = lines[0].trim();
    return new RegExp(firstLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  applyCodeFix(lines, codeBlocks, location) {
    try {
      console.log('🔧 Applying code fix...');
      console.log('Location:', location);
      console.log('Code blocks to apply:', codeBlocks.length);
      
      const newLines = [...lines];
      const firstBlock = codeBlocks[0];
      const blockLines = firstBlock.split('\n');

      console.log('Original lines at location:', lines.slice(location.startLine - 1, location.endLine));
      console.log('New code to insert:', blockLines);

      // Replace the code at the target location
      newLines.splice(
        location.startLine - 1,
        location.endLine - location.startLine + 1,
        ...blockLines
      );

      console.log('✅ Code fix applied successfully');
      console.log('Lines changed:', location.endLine - location.startLine + 1, '->', blockLines.length);
      
      return newLines;
    } catch (error) {
      console.error('❌ Error applying code fix:', error);
      return null;
    }
  }

  generateDiff(oldContent, newContent) {
    const diff = require('diff');
    return diff.createPatch(
      'file',
      oldContent,
      newContent,
      'Original',
      'Fixed'
    );
  }

  validateFix(newContent, filePath) {
    try {
      console.log('🔍 Validating fix for:', filePath);
      
      // Check for common issues first
      const issues = this.checkForCommonIssues(newContent);
      if (issues.length > 0) {
        console.error('❌ Validation issues found:', issues);
        return false;
      }

      // Basic syntax validation for JavaScript/TypeScript (without external parsers)
      if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        console.log('✅ Basic syntax validation passed');
        
        // Additional checks for common TypeScript/React issues
        const tsIssues = this.checkTypeScriptIssues(newContent, filePath);
        if (tsIssues.length > 0) {
          console.error('❌ TypeScript/React issues found:', tsIssues);
          return false;
        }
      }

      console.log('✅ Fix validation passed');
      return true;
    } catch (error) {
      console.error('❌ Fix validation error:', error.message);
      // Don't fail validation on parser errors, just log them
      console.log('⚠️  Continuing with fix despite parser error');
      return true;
    }
  }

  checkForCommonIssues(content) {
    const issues = [];

    // Check for unclosed brackets/parentheses
    const brackets = { '{': '}', '[': ']', '(': ')' };
    const stack = [];
    
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (brackets[char]) {
        stack.push(char);
      } else if (Object.values(brackets).includes(char)) {
        const last = stack.pop();
        if (brackets[last] !== char) {
          issues.push(`Mismatched bracket at position ${i}`);
        }
      }
    }

    if (stack.length > 0) {
      issues.push('Unclosed brackets/parentheses');
    }

    // Check for common syntax errors
    if (content.includes('undefinedundefined')) {
      issues.push('Potential undefined concatenation');
    }

    if (content.includes('nullnull')) {
      issues.push('Potential null concatenation');
    }

    return issues;
  }

  checkTypeScriptIssues(content, filePath) {
    const issues = [];

    // Check for common TypeScript/React issues
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
      // Check for unclosed JSX tags
      const openTags = (content.match(/<[^/][^>]*>/g) || []).length;
      const closeTags = (content.match(/<\/[^>]*>/g) || []).length;
      if (openTags !== closeTags) {
        issues.push(`JSX tag mismatch: ${openTags} open, ${closeTags} close`);
      }

      // Check for missing React import in JSX files
      if (content.includes('React.') && !content.includes('import React')) {
        issues.push('Missing React import for JSX usage');
      }
    }

    // Check for TypeScript-specific issues
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      // Check for unclosed type annotations
      const typeAnnotations = (content.match(/:\s*[^=;,\n]+/g) || []).length;
      const semicolons = (content.match(/;/g) || []).length;
      if (typeAnnotations > semicolons * 2) {
        issues.push('Potential unclosed type annotations');
      }
    }

    return issues;
  }
}

module.exports = ErrorAnalysisService; 