const { execSync } = require('child_process');
const OpenAI = require('openai');
const ContextBuilder = require('../utils/contextBuilder');
const path = require('path');
const fs = require('fs');
const diff = require('diff');

class EnhancedErrorAnalysisService {
  constructor(options = {}) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.contextBuilder = new ContextBuilder(options.maxTokens);
    
    // Enhanced analysis settings
    this.analysisHistory = new Map(); // Store past fixes for learning
    this.errorPatterns = new Map(); // Store common error patterns
  }

  async analyzeError(errorDetails, repoPath) {
    const results = {
      aiAnalysis: null,
      suggestedFixes: [],
      confidence: 0,
      context: null
    };

    try {
      // 1. Build comprehensive context
      const context = await this.contextBuilder.buildContext(
        path.join(repoPath, errorDetails.file),
        errorDetails.line,
        repoPath
      );
      results.context = context;

      // 2. Analyze error pattern and check history
      const errorPattern = this.analyzeErrorPattern(errorDetails);
      const historicalFix = this.findHistoricalFix(errorPattern);
      
      // 3. Run enhanced AI analysis with structured output
      results.aiAnalysis = await this.runEnhancedAIAnalysis(errorDetails, context, historicalFix);

      // 4. Generate multiple fix options with confidence scores
      results.suggestedFixes = await this.generateStructuredFixes(errorDetails, context, historicalFix);

      // 5. Validate and rank fixes
      results.suggestedFixes = await this.validateAndRankFixes(results.suggestedFixes, errorDetails, repoPath);

      // 6. Store successful patterns for future learning
      if (results.suggestedFixes.length > 0) {
        this.storeFixPattern(errorPattern, results.suggestedFixes[0]);
      }

      return results;
    } catch (error) {
      console.error('Error in enhanced analysis:', error);
      throw error;
    }
  }

  analyzeErrorPattern(errorDetails) {
    // Create a pattern key for similar errors
    const pattern = {
      errorType: errorDetails.errorType,
      errorMessage: errorDetails.error?.toLowerCase().replace(/[^a-z0-9]/g, ''),
      fileExtension: path.extname(errorDetails.file),
      lineContext: this.extractLineContext(errorDetails)
    };
    
    return JSON.stringify(pattern);
  }

  extractLineContext(errorDetails) {
    // Extract context around the error line for pattern matching
    try {
      const filePath = path.join(process.cwd(), errorDetails.file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const startLine = Math.max(0, errorDetails.line - 3);
        const endLine = Math.min(lines.length, errorDetails.line + 2);
        return lines.slice(startLine, endLine).join('\n').toLowerCase();
      }
    } catch (error) {
      console.warn('Could not extract line context:', error.message);
    }
    return '';
  }

  findHistoricalFix(errorPattern) {
    // Check if we've seen a similar error before
    const historicalFix = this.analysisHistory.get(errorPattern);
    if (historicalFix) {
      console.log('📚 Found historical fix for similar error pattern');
      return historicalFix;
    }
    return null;
  }

  async runEnhancedAIAnalysis(errorDetails, context, historicalFix) {
    const prompt = this.buildEnhancedAnalysisPrompt(errorDetails, context, historicalFix);
    
    const response = await this.openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are an expert code fixer with deep knowledge of JavaScript/TypeScript errors. 
          Analyze errors systematically and provide structured, safe fixes.
          
          Always follow this process:
          1. Identify the root cause
          2. Consider multiple solution approaches
          3. Choose the safest, most reliable fix
          4. Include proper error handling
          5. Maintain code quality and readability`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 2000
    });

    return this.parseEnhancedAIResponse(response.choices[0].message.content);
  }

  buildEnhancedAnalysisPrompt(errorDetails, context, historicalFix) {
    let prompt = `A Sentry error was reported in our application:

Error Type: ${errorDetails.errorType}
Error Message: ${errorDetails.error}
File: ${errorDetails.file}
Line: ${errorDetails.line}

Context:
${context}

`;

    if (historicalFix) {
      prompt += `Historical Fix Reference:
We've seen a similar error before. Here's what worked:
${historicalFix.explanation}

Code: ${historicalFix.code}

Consider this pattern but adapt it to the current context.
`;
    }

    prompt += `Please provide a structured analysis and fix:

1. Root Cause Analysis:
   - What is causing this error?
   - Is this a common pattern?

2. Solution Approach:
   - What are the possible solutions?
   - Which is the safest and most reliable?

3. Implementation:
   - Provide the complete fixed code
   - Include proper error handling
   - Add comments explaining the fix

4. Safety Considerations:
   - Will this fix break anything else?
   - What tests should be run?

Format your response with clear sections and code blocks.`;

    return prompt;
  }

  parseEnhancedAIResponse(response) {
    console.log('🤖 Enhanced AI Response:', response);
    
    // Extract structured sections
    const sections = {
      rootCause: this.extractSection(response, 'Root Cause Analysis', 'Solution Approach'),
      solutionApproach: this.extractSection(response, 'Solution Approach', 'Implementation'),
      implementation: this.extractSection(response, 'Implementation', 'Safety Considerations'),
      safetyConsiderations: this.extractSection(response, 'Safety Considerations')
    };

    // Extract code blocks
    const codeBlocks = response.match(/```[\s\S]*?```/g) || [];
    const fixCode = codeBlocks.length > 0 ? codeBlocks[0].replace(/```[\w]*\n?/, '').replace(/```$/, '') : '';

    return {
      rootCause: sections.rootCause || 'AI Analysis',
      suggestedFix: fixCode,
      explanation: sections.solutionApproach || sections.rootCause || 'AI-generated fix',
      testImpact: sections.safetyConsiderations || 'Unknown',
      confidence: this.calculateConfidence(response, fixCode),
      alternatives: this.extractAlternatives(response),
      structuredAnalysis: sections
    };
  }

  extractSection(text, startMarker, endMarker) {
    const startIndex = text.indexOf(startMarker);
    if (startIndex === -1) return '';
    
    const start = startIndex + startMarker.length;
    const end = endMarker ? text.indexOf(endMarker, start) : text.length;
    
    return text.substring(start, end).trim();
  }

  calculateConfidence(response, fixCode) {
    let confidence = 0.5; // Base confidence
    
    // Increase confidence based on indicators
    if (fixCode && fixCode.length > 10) confidence += 0.2;
    if (response.includes('Root Cause Analysis')) confidence += 0.1;
    if (response.includes('Safety Considerations')) confidence += 0.1;
    if (response.includes('error handling')) confidence += 0.1;
    if (response.includes('try') && response.includes('catch')) confidence += 0.1;
    
    return Math.min(confidence, 0.95);
  }

  extractAlternatives(response) {
    const alternatives = [];
    const altMatches = response.match(/Alternative[:\s]+([^.\n]+)/gi);
    if (altMatches) {
      alternatives.push(...altMatches.map(match => match.replace(/Alternative[:\s]+/i, '').trim()));
    }
    return alternatives.join('; ');
  }

  async generateStructuredFixes(errorDetails, context, historicalFix) {
    const fixes = [];

    // Primary AI fix
    if (this.aiAnalysis?.suggestedFix) {
      fixes.push({
        type: 'ai_enhanced',
        code: this.aiAnalysis.suggestedFix,
        confidence: this.aiAnalysis.confidence,
        source: 'Enhanced OpenAI Analysis',
        explanation: this.aiAnalysis.explanation,
        structuredAnalysis: this.aiAnalysis.structuredAnalysis
      });
    }

    // Historical fix adaptation
    if (historicalFix) {
      fixes.push({
        type: 'historical',
        code: historicalFix.code,
        confidence: Math.min(historicalFix.confidence + 0.1, 0.9),
        source: 'Historical Pattern',
        explanation: `Adapted from previous similar fix: ${historicalFix.explanation}`
      });
    }

    // Pattern-based fix
    const patternFix = this.generatePatternBasedFix(errorDetails);
    if (patternFix) {
      fixes.push({
        type: 'pattern',
        code: patternFix.code,
        confidence: 0.7,
        source: 'Error Pattern Analysis',
        explanation: patternFix.explanation
      });
    }

    return fixes.sort((a, b) => b.confidence - a.confidence);
  }

  generatePatternBasedFix(errorDetails) {
    // Generate fixes based on common error patterns
    const errorType = errorDetails.errorType?.toLowerCase();
    const errorMessage = errorDetails.error?.toLowerCase();

    if (errorType === 'referenceerror' || errorMessage?.includes('is not defined')) {
      return {
        code: `// Ensure variable is properly declared
const ${this.extractVariableName(errorMessage)} = ${this.suggestDefaultValue(errorMessage)};
`,
        explanation: 'Variable not defined - adding proper declaration'
      };
    }

    if (errorType === 'typeerror' || errorMessage?.includes('cannot read property')) {
      return {
        code: `// Add null/undefined check
if (${this.extractObjectName(errorMessage)}) {
  // Safe property access
  ${this.extractPropertyAccess(errorMessage)}
} else {
  console.warn('Object is null or undefined');
}`,
        explanation: 'Property access on null/undefined - adding safety check'
      };
    }

    return null;
  }

  extractVariableName(errorMessage) {
    const match = errorMessage?.match(/'([^']+)' is not defined/);
    return match ? match[1] : 'variable';
  }

  extractObjectName(errorMessage) {
    const match = errorMessage?.match(/Cannot read property '[^']+' of ([^ ]+)/);
    return match ? match[1] : 'object';
  }

  extractPropertyAccess(errorMessage) {
    const match = errorMessage?.match(/Cannot read property '([^']+)'/);
    return match ? `.${match[1]}` : '.property';
  }

  suggestDefaultValue(variableName) {
    if (variableName?.includes('array') || variableName?.includes('list')) return '[]';
    if (variableName?.includes('object') || variableName?.includes('obj')) return '{}';
    if (variableName?.includes('string') || variableName?.includes('str')) return "''";
    if (variableName?.includes('number') || variableName?.includes('num')) return '0';
    return 'null';
  }

  async validateAndRankFixes(fixes, errorDetails, repoPath) {
    const validatedFixes = [];

    for (const fix of fixes) {
      try {
        // Basic validation
        const isValid = await this.validateFix(fix, errorDetails, repoPath);
        if (isValid) {
          validatedFixes.push({
            ...fix,
            validation: 'passed'
          });
        }
      } catch (error) {
        console.warn(`Fix validation failed for ${fix.type}:`, error.message);
      }
    }

    return validatedFixes;
  }

  async validateFix(fix, errorDetails, repoPath) {
    // Basic syntax validation
    if (!fix.code || fix.code.length < 5) return false;

    // Check for dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/,
      /Function\s*\(/,
      /innerHTML\s*=/,
      /document\.write/,
      /process\.exit/
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(fix.code)) {
        console.warn(`Dangerous pattern detected in fix: ${pattern}`);
        return false;
      }
    }

    return true;
  }

  storeFixPattern(errorPattern, successfulFix) {
    // Store successful fixes for future reference
    this.analysisHistory.set(errorPattern, {
      code: successfulFix.code,
      explanation: successfulFix.explanation,
      confidence: successfulFix.confidence,
      timestamp: Date.now()
    });

    // Keep only recent patterns (last 100)
    if (this.analysisHistory.size > 100) {
      const entries = Array.from(this.analysisHistory.entries());
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      this.analysisHistory = new Map(entries.slice(0, 100));
    }
  }

  async applyFix(filePath, fix) {
    try {
      console.log('🔧 Applying enhanced fix to file:', filePath);

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      const fixCode = fix.code;
      console.log('🤖 Enhanced Fix:', fixCode);
      
      const errorLine = fix.errorLine || 1;
      const startLine = Math.max(0, errorLine - 5);
      const endLine = Math.min(lines.length, errorLine + 5);
      const originalBlock = lines.slice(startLine, endLine).join('\n');
      
      console.log('📍 Original block (lines', startLine + 1, 'to', endLine, '):', originalBlock);
      
      // Enhanced diff comparison
      const changes = diff.diffLines(originalBlock, fixCode);
      const hasMeaningfulChange = changes.some(change =>
        (change.added || change.removed) &&
        change.value.replace(/\s/g, '').length > 0
      );
      
      console.log('🔍 Has meaningful change:', hasMeaningfulChange);
      console.log('📊 Fix confidence:', fix.confidence);
      
      if (hasMeaningfulChange && fix.confidence > 0.6) {
        // Apply the fix
        const newLines = [...lines];
        newLines.splice(startLine, endLine - startLine, ...fixCode.split('\n'));
      
        fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
        console.log('✅ Enhanced fix applied successfully to file:', filePath);
      
        return {
          success: true,
          diff: changes,
          location: { startLine, endLine },
          confidence: fix.confidence,
          source: fix.source
        };
      } else {
        console.log('⚠️  Fix rejected: Low confidence or no meaningful changes');
        return {
          success: false,
          reason: fix.confidence <= 0.6 ? 'Low confidence' : 'No meaningful changes detected'
        };
      }
    } catch (error) {
      console.error('❌ Error applying enhanced fix:', error);
      return {
        success: false,
        reason: error.message
      };
    }
  }
}

module.exports = EnhancedErrorAnalysisService; 