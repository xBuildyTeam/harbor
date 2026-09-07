/**
 * Harbor Shared Utilities
 * Loaded globally in renderer files.
 */
const sharedUtils = {
  /**
   * Formats a byte number to a human-readable string (KB, MB, GB, etc.)
   */
  formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 GB';
    const k = 1024;
    const dm = 1; // 1 decimal place
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  },

  /**
   * Formats temperature with degree symbol
   */
  formatTemp(temp) {
    if (temp === undefined || temp === null || isNaN(temp)) return '--°C';
    return `${temp}°C`;
  },

  /**
   * Truncates URL with ellipsis
   */
  truncateUrl(url, maxLen = 28) {
    if (!url) return '';
    if (url.length <= maxLen) return url;
    // Remove protocol for display if long
    let cleanUrl = url.replace(/^(https?:\/\/)?(www\.)?/, '');
    if (cleanUrl.length <= maxLen) return cleanUrl;
    return cleanUrl.substring(0, maxLen - 3) + '...';
  },

  /**
   * Simple markdown renderer that supports bold, lists, inline code, and code blocks.
   * Escapes HTML securely to prevent injection.
   */
  renderMarkdown(text) {
    if (!text) return '';

    // Step 1: Escape basic HTML entities to avoid injection
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Step 2: Extract and render code blocks (```code```)
    const codeBlocks = [];
    html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
      const id = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
      return id;
    });

    // Step 3: Inline code (`code`)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Step 4: Bold (**text**)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Step 5: Unordered lists (- item or * item)
    const lines = html.split('\n');
    let inList = false;
    const formattedLines = lines.map(line => {
      const listMatch = line.match(/^([-*])\s+(.+)$/);
      if (listMatch) {
        let prefix = '';
        if (!inList) {
          inList = true;
          prefix = '<ul>';
        }
        return prefix + `<li>${listMatch[2]}</li>`;
      } else {
        let prefix = '';
        if (inList) {
          inList = false;
          prefix = '</ul>';
        }
        return prefix + line;
      }
    });
    
    html = formattedLines.join('\n');
    if (inList) {
      html += '</ul>';
    }

    // Step 6: Map code blocks back to prevent their interior being modified
    codeBlocks.forEach((block, index) => {
      html = html.replace(`__CODE_BLOCK_${index}__`, block);
    });

    // Step 7: Convert remaining newlines into <br> except inside block tags
    return html.split(/(<pre>[\s\S]*?<\/pre>|<ul>[\s\S]*?<\/ul>)/g).map((chunk) => {
      if (chunk.startsWith('<pre>') || chunk.startsWith('<ul>')) {
        return chunk;
      }
      return chunk.replace(/\n/g, '<br>');
    }).join('');
  },

  /**
   * Copy string helper using modern clipboard API
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error('Failed to copy:', e);
      return false;
    }
  }
};

// Expose globally
window.sharedUtils = sharedUtils;
