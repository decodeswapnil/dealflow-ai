#!/usr/bin/env node
/**
 * Architecture Report PDF Generator
 * Converts Markdown with Mermaid diagrams to professional PDF
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the markdown report
const mdPath = join(__dirname, 'report.md');
const mdContent = readFileSync(mdPath, 'utf-8');

// Custom renderer for Mermaid diagrams
const renderer = new marked.Renderer();
const mermaidBlocks = [];
let mermaidIndex = 0;

renderer.code = function(code, language) {
  if (language === 'mermaid') {
    const id = `mermaid-${mermaidIndex++}`;
    mermaidBlocks.push({ id, code });
    return `<div class="mermaid-diagram" id="${id}"><pre class="mermaid">${code}</pre></div>`;
  }
  return `<pre><code class="language-${language}">${code}</code></pre>`;
};

// Convert markdown to HTML
marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
  headerIds: true
});

const htmlBody = marked(mdContent);

// Create full HTML document with Mermaid support
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Affiliate Automation Platform - System Architecture Report</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    @page {
      size: A4;
      margin: 20mm 15mm 25mm 15mm;
      @bottom-center {
        content: counter(page);
        font-size: 10pt;
        color: #666;
      }
      @top-left {
        content: "AI Affiliate Automation Platform";
        font-size: 8pt;
        color: #999;
        font-style: italic;
      }
    }
    
    * {
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 10.5pt;
      line-height: 1.6;
      color: #333;
      max-width: 100%;
      margin: 0;
      padding: 0;
    }
    
    h1 {
      font-size: 24pt;
      color: #1a237e;
      border-bottom: 3px solid #1a237e;
      padding-bottom: 10px;
      margin-top: 0;
      page-break-before: avoid;
    }
    
    h2 {
      font-size: 16pt;
      color: #283593;
      border-bottom: 2px solid #c5cae9;
      padding-bottom: 8px;
      margin-top: 30px;
      page-break-after: avoid;
    }
    
    h3 {
      font-size: 13pt;
      color: #3949ab;
      margin-top: 25px;
      page-break-after: avoid;
    }
    
    h4 {
      font-size: 11pt;
      color: #5c6bc0;
      margin-top: 20px;
    }
    
    p {
      margin: 10px 0;
      text-align: justify;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    
    th {
      background-color: #1a237e;
      color: white;
      padding: 10px 8px;
      text-align: left;
      font-weight: 600;
      border: 1px solid #1a237e;
    }
    
    td {
      padding: 8px;
      border: 1px solid #e0e0e0;
      vertical-align: top;
    }
    
    tr:nth-child(even) {
      background-color: #f5f5f5;
    }
    
    tr:hover {
      background-color: #e8eaf6;
    }
    
    pre {
      background-color: #263238;
      color: #aed581;
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 9pt;
      line-height: 1.4;
      page-break-inside: avoid;
    }
    
    code {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 9pt;
    }
    
    pre code {
      color: #aed581;
      background: none;
      padding: 0;
    }
    
    :not(pre) > code {
      background-color: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      color: #d32f2f;
      font-size: 9.5pt;
    }
    
    ul, ol {
      margin: 10px 0;
      padding-left: 25px;
    }
    
    li {
      margin: 5px 0;
    }
    
    blockquote {
      border-left: 4px solid #1a237e;
      margin: 15px 0;
      padding: 10px 20px;
      background-color: #e8eaf6;
      font-style: italic;
    }
    
    hr {
      border: none;
      border-top: 2px solid #c5cae9;
      margin: 30px 0;
    }
    
    .mermaid-diagram {
      text-align: center;
      margin: 20px 0;
      padding: 15px;
      background-color: #fafafa;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      page-break-inside: avoid;
    }
    
    .mermaid {
      display: flex;
      justify-content: center;
    }
    
    /* Cover page styling */
    .cover-page {
      text-align: center;
      padding: 100px 50px;
      page-break-after: always;
    }
    
    .cover-title {
      font-size: 32pt;
      color: #1a237e;
      margin-bottom: 20px;
      font-weight: 700;
    }
    
    .cover-subtitle {
      font-size: 18pt;
      color: #5c6bc0;
      margin-bottom: 60px;
    }
    
    .cover-meta {
      font-size: 12pt;
      color: #666;
      line-height: 2;
    }
    
    /* Table of contents styling */
    .toc {
      page-break-after: always;
    }
    
    .toc h2 {
      text-align: center;
      border-bottom: none;
    }
    
    .toc ul {
      list-style: none;
      padding: 0;
    }
    
    .toc li {
      padding: 8px 0;
      border-bottom: 1px dotted #ccc;
    }
    
    .toc a {
      color: #333;
      text-decoration: none;
    }
    
    /* Executive summary boxes */
    .metric-box {
      display: inline-block;
      background: linear-gradient(135deg, #1a237e, #3949ab);
      color: white;
      padding: 15px 25px;
      margin: 10px;
      border-radius: 8px;
      text-align: center;
      min-width: 150px;
    }
    
    .metric-value {
      font-size: 24pt;
      font-weight: bold;
      display: block;
    }
    
    .metric-label {
      font-size: 9pt;
      opacity: 0.9;
    }
    
    /* Print optimizations */
    @media print {
      body {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      
      h1, h2, h3 {
        page-break-after: avoid;
      }
      
      table, pre, .mermaid-diagram {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="cover-page">
    <div class="cover-title">AI Affiliate Automation Platform</div>
    <div class="cover-subtitle">System Architecture Report</div>
    <div class="cover-meta">
      <strong>Version:</strong> 2.0<br>
      <strong>Date:</strong> December 2026<br>
      <strong>Classification:</strong> Internal Use<br><br>
      <em>Production-grade multi-agent AI system for autonomous deal discovery,<br>
      analysis, and distribution</em>
    </div>
  </div>
  
  ${htmlBody}
  
  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      themeVariables: {
        primaryColor: '#e8eaf6',
        primaryTextColor: '#1a237e',
        primaryBorderColor: '#3949ab',
        lineColor: '#5c6bc0',
        secondaryColor: '#c5cae9',
        tertiaryColor: '#f5f5f5',
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: '14px'
      },
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      },
      sequence: {
        useMaxWidth: true,
        diagramMarginX: 50,
        diagramMarginY: 10
      },
      er: {
        useMaxWidth: true
      }
    });
  </script>
</body>
</html>`;

// Write HTML file
const htmlPath = join(__dirname, 'report.html');
writeFileSync(htmlPath, htmlTemplate);
console.log('✓ HTML report generated');

// Generate PDF using Puppeteer
async function generatePDF() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Load HTML file
  await page.goto('file://' + htmlPath, {
    waitUntil: 'networkidle0',
    timeout: 60000
  });
  
  // Wait for Mermaid diagrams to render
  console.log('Rendering Mermaid diagrams...');
  await page.waitForFunction(() => {
    const mermaids = document.querySelectorAll('.mermaid');
    return Array.from(mermaids).every(m => m.querySelector('svg') !== null);
  }, { timeout: 120000 });
  
  // Additional wait for SVG rendering
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('Generating PDF...');
  
  // Generate PDF
  const pdfPath = join(__dirname, 'architecture-report.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '20mm',
      right: '15mm',
      bottom: '25mm',
      left: '15mm'
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size: 8pt; color: #999; width: 100%; text-align: left; padding: 0 15mm;">
        AI Affiliate Automation Platform — System Architecture Report
      </div>
    `,
    footerTemplate: `
      <div style="font-size: 9pt; color: #666; width: 100%; text-align: center; padding: 0 15mm;">
        <span class="pageNumber"></span> / <span class="totalPages"></span>
      </div>
    `
  });
  
  await browser.close();
  
  console.log('✓ PDF generated successfully!');
  console.log('  Location:', pdfPath);
  
  // Get file size
  const stats = readFileSync(pdfPath);
  console.log('  Size:', (stats.length / 1024 / 1024).toFixed(2), 'MB');
}

generatePDF().catch(err => {
  console.error('Error generating PDF:', err);
  process.exit(1);
});
