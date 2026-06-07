#!/usr/bin/env node
/**
 * Architecture Report PDF Generator with Pre-rendered Diagrams
 * Extracts Mermaid diagrams, converts to SVG, then generates PDF
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const mdPath = join(__dirname, 'report.md');
const diagramsDir = join(__dirname, 'diagrams');
const outputDir = join(__dirname, 'output');

// Ensure directories exist
if (!existsSync(diagramsDir)) mkdirSync(diagramsDir, { recursive: true });
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

// Read markdown
const mdContent = readFileSync(mdPath, 'utf-8');

// Extract mermaid blocks
const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
const mermaidBlocks = [];
let match;
let index = 0;

while ((match = mermaidRegex.exec(mdContent)) !== null) {
  mermaidBlocks.push({
    index: index++,
    code: match[1].trim(),
    fullMatch: match[0]
  });
}

console.log(`Found ${mermaidBlocks.length} Mermaid diagrams`);

// Convert each diagram to SVG
console.log('Converting diagrams to SVG...');
const diagramFiles = [];

for (const block of mermaidBlocks) {
  const mmdFile = join(diagramsDir, `diagram-${block.index}.mmd`);
  const svgFile = join(diagramsDir, `diagram-${block.index}.svg`);
  const pngFile = join(diagramsDir, `diagram-${block.index}.png`);
  
  // Write mmd file
  writeFileSync(mmdFile, block.code);
  
  try {
    // Convert to SVG using mmdc
    execSync(`npx mmdc -i "${mmdFile}" -o "${svgFile}" -b transparent -t default`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
    
    // Convert SVG to PNG for better PDF compatibility
    execSync(`npx svgexport "${svgFile}" "${pngFile}" 2x`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
    
    diagramFiles.push({
      index: block.index,
      pngFile: pngFile,
      svgFile: svgFile
    });
    
    console.log(`  ✓ Diagram ${block.index + 1}/${mermaidBlocks.length} converted`);
  } catch (err) {
    console.error(`  ✗ Diagram ${block.index + 1} failed:`, err.message);
    // Create a placeholder
    diagramFiles.push({
      index: block.index,
      pngFile: null,
      svgFile: null
    });
  }
}

// Replace mermaid blocks with image references in markdown
let processedMd = mdContent;
for (let i = mermaidBlocks.length - 1; i >= 0; i--) {
  const block = mermaidBlocks[i];
  const diagram = diagramFiles[i];
  
  if (diagram.pngFile && existsSync(diagram.pngFile)) {
    // Use relative path for the image
    const relativePath = `./diagrams/diagram-${i}.png`;
    const imageRef = `\n![Architecture Diagram ${i + 1}](${relativePath})\n`;
    processedMd = processedMd.replace(block.fullMatch, imageRef);
  }
}

// Save processed markdown
const processedMdPath = join(__dirname, 'report-with-images.md');
writeFileSync(processedMdPath, processedMd);
console.log('✓ Processed markdown saved');

// Convert to HTML
const renderer = new marked.Renderer();
renderer.image = function(href, title, text) {
  // Convert relative paths to absolute
  if (href.startsWith('./')) {
    href = join(__dirname, href.substring(2));
  }
  return `<img src="file://${href}" alt="${text}" style="max-width: 100%; height: auto; margin: 15px 0;" />`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false
});

const htmlBody = marked(processedMd);

// Create full HTML document
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Affiliate Automation Platform - System Architecture Report</title>
  <style>
    @page {
      size: A4;
      margin: 20mm 15mm 25mm 15mm;
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
    
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 15px auto;
      page-break-inside: avoid;
    }
    
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
    
    @media print {
      body {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      
      h1, h2, h3 {
        page-break-after: avoid;
      }
      
      table, pre, img {
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
</body>
</html>`;

const htmlPath = join(__dirname, 'report-final.html');
writeFileSync(htmlPath, htmlTemplate);
console.log('✓ Final HTML generated');

// Generate PDF
async function generatePDF() {
  console.log('Launching browser for PDF generation...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  await page.goto('file://' + htmlPath, {
    waitUntil: 'networkidle0',
    timeout: 60000
  });
  
  // Wait for images to load
  await page.waitForFunction(() => {
    const images = document.querySelectorAll('img');
    return Array.from(images).every(img => img.complete);
  }, { timeout: 30000 });
  
  console.log('Generating PDF...');
  
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
      <div style="font-size: 8pt; color: #999; width: 100%; text-align: left; padding: 0 15mm; font-family: 'Segoe UI', sans-serif;">
        AI Affiliate Automation Platform — System Architecture Report
      </div>
    `,
    footerTemplate: `
      <div style="font-size: 9pt; color: #666; width: 100%; text-align: center; padding: 0 15mm; font-family: 'Segoe UI', sans-serif;">
        <span class="pageNumber"></span> / <span class="totalPages"></span>
      </div>
    `
  });
  
  await browser.close();
  
  const stats = readFileSync(pdfPath);
  console.log('\n✅ PDF Report Generated Successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📄 File:', pdfPath);
  console.log('📊 Size:', (stats.length / 1024 / 1024).toFixed(2), 'MB');
  console.log('📈 Diagrams:', mermaidBlocks.length);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

generatePDF().catch(err => {
  console.error('Error generating PDF:', err);
  process.exit(1);
});
