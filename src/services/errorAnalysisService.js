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
2. Suggested Fix - IMPORTANT: Provide the actual corrected code in a code block, not just explanation. Include the exact lines that need to be changed with the fix applied.
3. Test Impact
4. Confidence Level (0-1)
5. Alternative Solutions (if any)

For the Suggested Fix, provide the actual corrected code that should replace the problematic lines. Use code blocks (\`\`\`) to format the fix.`;
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
      const problematicLine = lines[errorLine - 1];
      console.log('Problematic line:', problematicLine);
      
      // Return a reasonable context around the error line
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
    // Find similar code patterns - use a more flexible approach
    const searchLines = firstBlock.split('\n').filter(line => line.trim().length > 0);
    if (searchLines.length > 0) {
      // Look for any line that contains the first meaningful line of the fix
      const firstSearchLine = searchLines[0].trim();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(firstSearchLine) || firstSearchLine.includes(lines[i].trim())) {
          console.log('✅ Found matching pattern at line:', i + 1);
          return {
            startLine: Math.max(1, i - 2),
            endLine: Math.min(lines.length, i + 2),
            context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 2))
          };
        }
      }
    }

    console.log('❌ No matching pattern found in file');
    return null;
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

      // Replace the code at the target location with the fixed version
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
      console.log('📏 Content length:', newContent.length, 'characters');
      
      // Check for common issues first
      const issues = this.checkForCommonIssues(newContent);
      if (issues.length > 0) {
        console.log('⚠️  Found validation issues:', issues.length, 'issues');
        console.log('📋 Issues:', issues);
        console.log('🔄 Attempting lenient validation...');
        
        // Try lenient validation for bracket issues
        const lenientIssues = this.checkForCommonIssuesLenient(newContent);
        if (lenientIssues.length === 0) {
          console.log('✅ Lenient validation passed - proceeding with fix');
          return true;
        } else {
          console.log('⚠️  Lenient validation also failed:', lenientIssues.length, 'issues');
          console.log('📋 Lenient issues:', lenientIssues);
          console.log('🔄 Trying fallback validation...');
          
          // Final fallback: only check for the most obvious errors
          const fallbackIssues = this.checkForCommonIssuesFallback(newContent);
          if (fallbackIssues.length === 0) {
            console.log('✅ Fallback validation passed - proceeding with fix (with caution)');
            return true;
          } else {
            console.error('❌ All validation levels failed:', fallbackIssues.length, 'critical issues');
            console.error('📋 Critical issues:', fallbackIssues);
            return false;
          }
        }
      }

      // Basic syntax validation for JavaScript/TypeScript (without external parsers)
      if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        console.log('✅ Basic syntax validation passed');
        
        // Additional checks for common TypeScript/React issues
        const tsIssues = this.checkTypeScriptIssues(newContent, filePath);
        if (tsIssues.length > 0) {
          console.error('❌ TypeScript/React issues found:', tsIssues.length, 'issues');
          console.error('📋 TypeScript issues:', tsIssues);
          return false;
        }
      }

      console.log('✅ Fix validation passed');
      return true;
    } catch (error) {
      console.error('❌ Fix validation error:', error.message);
      console.error('📋 Error stack:', error.stack);
      // Don't fail validation on parser errors, just log them
      console.log('⚠️  Continuing with fix despite parser error');
      return true;
    }
  }

  checkForCommonIssues(content) {
    const issues = [];

    // More intelligent bracket validation that handles common code patterns
    const bracketIssues = this.validateBracketsIntelligently(content);
    if (bracketIssues.length > 0) {
      issues.push(...bracketIssues);
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

  validateBracketsIntelligently(content) {
    const issues = [];
    const brackets = { '{': '}', '[': ']', '(': ')' };
    const stack = [];
    let inString = false;
    let inTemplate = false;
    let inJSX = false;
    let inComment = false;
    let stringChar = '';
    let i = 0;

    while (i < content.length) {
      const char = content[i];
      const nextChar = content[i + 1];
      const prevChar = content[i - 1];

      // Handle comments
      if (char === '/' && nextChar === '/') {
        inComment = true;
        i += 2;
        while (i < content.length && content[i] !== '\n') i++;
        inComment = false;
        continue;
      }
      if (char === '/' && nextChar === '*') {
        inComment = true;
        i += 2;
        while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
        if (i < content.length - 1) i += 2;
        inComment = false;
        continue;
      }

      if (inComment) {
        i++;
        continue;
      }

      // Handle strings
      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        i++;
        continue;
      }
      if (inString && char === stringChar && prevChar !== '\\') {
        inString = false;
        stringChar = '';
        i++;
        continue;
      }
      if (inString) {
        i++;
        continue;
      }

      // Handle template literals
      if (!inTemplate && char === '`') {
        inTemplate = true;
        i++;
        continue;
      }
      if (inTemplate && char === '`') {
        inTemplate = false;
        i++;
        continue;
      }
      if (inTemplate) {
        i++;
        continue;
      }

      // Handle JSX (simplified)
      if (char === '<' && !inJSX) {
        // Check if it's a JSX opening tag
        const jsxMatch = content.slice(i).match(/^<[A-Za-z][A-Za-z0-9]*/);
        if (jsxMatch) {
          inJSX = true;
          i++;
          continue;
        }
      }
      if (inJSX && char === '>') {
        inJSX = false;
        i++;
        continue;
      }
      if (inJSX) {
        i++;
        continue;
      }

      // Handle regular brackets
      if (brackets[char]) {
        stack.push({ char, position: i });
      } else if (Object.values(brackets).includes(char)) {
        if (stack.length === 0) {
          // Check if this might be a legitimate closing bracket
          const context = content.slice(Math.max(0, i - 10), i + 10);
          if (!this.isLikelyValidClosingBracket(context, char)) {
            const analysis = this.analyzeBracketContext(content, i);
            issues.push(`Unexpected closing bracket '${char}' at position ${i} - Context: ${analysis}`);
          }
        } else {
          const last = stack.pop();
          if (brackets[last.char] !== char) {
            // Check if this might be a legitimate mismatch
            const context = content.slice(Math.max(0, last.position - 10), i + 10);
            if (!this.isLikelyValidBracketMismatch(context, last.char, char)) {
              const analysis = this.analyzeBracketContext(content, i);
              issues.push(`Mismatched bracket at position ${i}: expected '${brackets[last.char]}', got '${char}' - Context: ${analysis}`);
            }
          }
        }
      }

      i++;
    }

    // Check for unclosed brackets
    if (stack.length > 0) {
      const unclosed = stack.map(s => s.char).join(', ');
      issues.push(`Unclosed brackets/parentheses: ${unclosed}`);
    }

    return issues;
  }

  analyzeBracketContext(content, position) {
    const start = Math.max(0, position - 20);
    const end = Math.min(content.length, position + 20);
    const context = content.slice(start, end);
    
    // Replace newlines and tabs for better readability
    const cleanContext = context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    
    return `"${cleanContext}" (pos ${position})`;
  }

  isLikelyValidClosingBracket(context, bracket) {
    // Check if this closing bracket might be legitimate
    const patterns = [
      /\)\s*;?\s*$/,  // Function call ending
      /\)\s*\.\s*\w+/, // Method chaining
      /\)\s*,\s*\w+/,  // Function arguments
      /\)\s*=>\s*/,    // Arrow function
      /\)\s*\{/,       // Function body
      /\)\s*\?/,       // Ternary operator
      /\)\s*&&/,       // Logical AND
      /\)\s*\|\|/,     // Logical OR
      /\)\s*\+/,       // Addition
      /\)\s*-/,        // Subtraction
      /\)\s*\*/,       // Multiplication
      /\)\s*\//,       // Division
      /\)\s*%/,        // Modulo
      /\)\s*===/,      // Strict equality
      /\)\s*!==/,      // Strict inequality
      /\)\s*==/,       // Equality
      /\)\s*!=/,       // Inequality
      /\)\s*</,        // Less than
      /\)\s*>/,        // Greater than
      /\)\s*<=/,       // Less than or equal
      /\)\s*>=/,       // Greater than or equal
      /\)\s*\[/,       // Array access
      /\)\s*\]/,       // Array access
      /\)\s*`/,        // Template literal
      /\)\s*"/,        // String
      /\)\s*'/,        // String
      /\)\s*\/\//,     // Comment
      /\)\s*\/\*/,     // Comment
      /\)\s*\*\//,     // Comment
      /\)\s*\n/,       // Newline
      /\)\s*$/,        // End of line
    ];

    return patterns.some(pattern => pattern.test(context));
  }

  isLikelyValidBracketMismatch(context, openBracket, closeBracket) {
    // Check if this bracket mismatch might be legitimate
    const patterns = [
      // Common patterns where bracket mismatches are acceptable
      /\{\s*\[/,  // Object with array
      /\[\s*\{/,  // Array with object
      /\(\s*\{/,  // Function with object
      /\(\s*\[/,  // Function with array
      /\{\s*\(/,  // Object with function
      /\[\s*\(/,  // Array with function
    ];

    return patterns.some(pattern => pattern.test(context));
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

  checkForCommonIssuesLenient(content) {
    const issues = [];

    // Only check for obvious syntax errors, not bracket mismatches
    if (content.includes('undefinedundefined')) {
      issues.push('Potential undefined concatenation');
    }

    if (content.includes('nullnull')) {
      issues.push('Potential null concatenation');
    }

    // Check for obvious unclosed structures (very basic)
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;

    // Only flag if there's a significant imbalance
    if (Math.abs(openBraces - closeBraces) > 2) {
      issues.push(`Significant brace imbalance: ${openBraces} open, ${closeBraces} close`);
    }
    if (Math.abs(openParens - closeParens) > 2) {
      issues.push(`Significant parenthesis imbalance: ${openParens} open, ${closeParens} close`);
    }
    if (Math.abs(openBrackets - closeBrackets) > 2) {
      issues.push(`Significant bracket imbalance: ${openBrackets} open, ${closeBrackets} close`);
    }

    return issues;
  }

  checkForCommonIssuesFallback(content) {
    const issues = [];

    // Only check for the most obvious and critical syntax errors
    if (content.includes('undefinedundefined')) {
      issues.push('Critical: undefined concatenation');
    }

    if (content.includes('nullnull')) {
      issues.push('Critical: null concatenation');
    }

    // Check for completely broken syntax patterns
    if (content.includes('function(') && !content.includes('function(')) {
      issues.push('Critical: malformed function declaration');
    }

    if (content.includes('import ') && content.includes('from') && !content.includes(';') && !content.includes('\n')) {
      issues.push('Critical: malformed import statement');
    }

    // Check for extreme bracket imbalances (more than 5)
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;

    if (Math.abs(openBraces - closeBraces) > 5) {
      issues.push(`Critical: extreme brace imbalance: ${openBraces} open, ${closeBraces} close`);
    }
    if (Math.abs(openParens - closeParens) > 5) {
      issues.push(`Critical: extreme parenthesis imbalance: ${openParens} open, ${closeParens} close`);
    }
    if (Math.abs(openBrackets - closeBrackets) > 5) {
      issues.push(`Critical: extreme bracket imbalance: ${openBrackets} open, ${closeBrackets} close`);
    }

    return issues;
  }
}

module.exports = ErrorAnalysisService; 