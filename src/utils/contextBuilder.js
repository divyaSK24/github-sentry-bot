const fs = require('fs');
const path = require('path');
const glob = require('glob');

class ContextBuilder {
  constructor(maxTokens = 4000) {
    this.maxTokens = maxTokens;
    this.currentTokens = 0;
  }

  // Estimate tokens (rough approximation)
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  // Get file content with line numbers
  getFileContent(filePath, startLine, endLine) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').split('\n');
      const relevantLines = content.slice(startLine - 1, endLine);
      return relevantLines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return '';
    }
  }

  // Find related files based on imports and dependencies
  async findRelatedFiles(filePath, repoPath) {
    try {
      // Check if the file exists before trying to read it
      if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}`);
        return [];
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const fileDir = path.dirname(filePath);
      
      // Find imports
      const importPatterns = {
        js: /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g,
        ts: /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g,
        java: /(?:import|package)\s+([^;]+);/g
      };

      const ext = path.extname(filePath).slice(1);
      const pattern = importPatterns[ext] || importPatterns.js;
      const imports = [...fileContent.matchAll(pattern)].map(m => m[1]);

      // Find related files
      const relatedFiles = new Set();
      for (const imp of imports) {
        try {
          const matches = glob.sync(`**/${imp}*`, { 
            cwd: repoPath,
            absolute: true,
            ignore: ['**/node_modules/**', '**/dist/**']
          });
          matches.forEach(m => relatedFiles.add(m));
        } catch (error) {
          console.warn(`Error finding imports for ${imp}:`, error.message);
        }
      }

      return Array.from(relatedFiles);
    } catch (error) {
      console.error(`Error in findRelatedFiles for ${filePath}:`, error.message);
      return [];
    }
  }

  // Build comprehensive context
  async buildContext(errorFile, errorLine, repoPath) {
    let context = '';
    this.currentTokens = 0;

    // 1. Get error file context
    if (fs.existsSync(errorFile)) {
      const errorContext = this.getFileContent(
        errorFile,
        Math.max(1, errorLine - 10),
        errorLine + 10
      );
      context += `\n=== Error File (${path.basename(errorFile)}) ===\n${errorContext}\n`;
      this.currentTokens += this.estimateTokens(errorContext);
    } else {
      console.warn(`Error file not found: ${errorFile}`);
      context += `\n=== Error File (${path.basename(errorFile)}) ===\nFile not found in repository\n`;
    }

    // 2. Find and add related files (only if error file exists)
    if (fs.existsSync(errorFile)) {
      const relatedFiles = await this.findRelatedFiles(errorFile, repoPath);
      for (const file of relatedFiles) {
        if (this.currentTokens >= this.maxTokens) break;

        const fileContent = this.getFileContent(file, 1, 50); // First 50 lines
        const tokens = this.estimateTokens(fileContent);
        
        if (this.currentTokens + tokens <= this.maxTokens) {
          context += `\n=== Related File (${path.basename(file)}) ===\n${fileContent}\n`;
          this.currentTokens += tokens;
        }
      }
    }

    // 3. Add project structure
    const projectStructure = this.getProjectStructure(repoPath);
    const structureTokens = this.estimateTokens(projectStructure);
    
    if (this.currentTokens + structureTokens <= this.maxTokens) {
      context += `\n=== Project Structure ===\n${projectStructure}\n`;
    }

    return context;
  }

  // Get project structure
  getProjectStructure(repoPath) {
    try {
      if (!fs.existsSync(repoPath)) {
        console.warn(`Repository path does not exist: ${repoPath}`);
        return 'Repository not found';
      }

      const structure = [];
      const ignorePatterns = ['node_modules', 'dist', '.git', 'coverage'];

      function buildTree(dir, level = 0) {
        try {
          const items = fs.readdirSync(dir);
          items.forEach(item => {
            if (ignorePatterns.some(pattern => item.includes(pattern))) return;
            
            const fullPath = path.join(dir, item);
            try {
              const stats = fs.statSync(fullPath);
              
              if (stats.isDirectory()) {
                structure.push('  '.repeat(level) + `📁 ${item}/`);
                buildTree(fullPath, level + 1);
              } else {
                structure.push('  '.repeat(level) + `📄 ${item}`);
              }
            } catch (error) {
              console.warn(`Error reading ${fullPath}:`, error.message);
            }
          });
        } catch (error) {
          console.warn(`Error reading directory ${dir}:`, error.message);
        }
      }

      buildTree(repoPath);
      return structure.join('\n');
    } catch (error) {
      console.error(`Error getting project structure for ${repoPath}:`, error.message);
      return 'Error reading project structure';
    }
  }
}

module.exports = ContextBuilder; 