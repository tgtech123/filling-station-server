// Generates docs/user-guide.docx from docs/user-guide.md
// Run: node docs/generate-word-guide.js

const fs   = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ShadingType, convertInchesToTwip,
  PageOrientation, Header, Footer, PageNumber,
  NumberFormat, UnderlineType,
} = require("docx");

// ── Colours ──────────────────────────────────────────────────
const BRAND_BLUE   = "1a71f6";
const HEADING1_CLR = "1a71f6";
const HEADING2_CLR = "1a3a5c";
const HEADING3_CLR = "2d5a8e";
const TABLE_HDR    = "1a71f6";
const TABLE_ROW_ALT = "EEF4FF";
const LIGHT_GREY   = "F5F7FA";
const BORDER_CLR   = "C5D5EA";

// ── Font sizes (half-points) ──────────────────────────────────
const SZ_BODY   = 22;  // 11pt
const SZ_H1     = 40;  // 20pt
const SZ_H2     = 32;  // 16pt
const SZ_H3     = 26;  // 13pt
const SZ_H4     = 24;  // 12pt
const SZ_SMALL  = 18;  // 9pt
const SZ_CAPTION = 20; // 10pt

// ── Cell border helper ───────────────────────────────────────
function cellBorders(color = BORDER_CLR) {
  const b = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: b, bottom: b, left: b, right: b };
}

// ── Shared paragraph spacing ─────────────────────────────────
function spacing(before = 0, after = 100, line = 276) {
  return { before, after, line };
}

// ── Plain text run ────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({ text, font: "Calibri", size: SZ_BODY, ...opts });
}

// ── Heading 1 (##-style, top-level sections) ──────────────────
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: spacing(320, 120),
    children: [
      new TextRun({
        text,
        font: "Calibri",
        size: SZ_H1,
        bold: true,
        color: HEADING1_CLR,
      }),
    ],
  });
}

// ── Heading 2 (###) ───────────────────────────────────────────
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: spacing(240, 80),
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_CLR },
    },
    children: [
      new TextRun({
        text,
        font: "Calibri",
        size: SZ_H2,
        bold: true,
        color: HEADING2_CLR,
      }),
    ],
  });
}

// ── Heading 3 (####) ─────────────────────────────────────────
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: spacing(160, 60),
    children: [
      new TextRun({
        text,
        font: "Calibri",
        size: SZ_H3,
        bold: true,
        color: HEADING3_CLR,
      }),
    ],
  });
}

// ── Heading 4 (##### or Step N) ──────────────────────────────
function h4(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_4,
    spacing: spacing(120, 40),
    children: [
      new TextRun({
        text,
        font: "Calibri",
        size: SZ_H4,
        bold: true,
        color: HEADING3_CLR,
        italics: true,
      }),
    ],
  });
}

// ── Body paragraph (handles inline **bold** and `code`) ───────
function para(raw, indent = 0) {
  const children = [];
  // Split on **bold**, `code`, or normal text
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    if (m.index > last) {
      children.push(run(raw.slice(last, m.index)));
    }
    const token = m[0];
    if (token.startsWith("**")) {
      children.push(run(token.slice(2, -2), { bold: true }));
    } else {
      // inline code
      children.push(
        new TextRun({
          text: token.slice(1, -1),
          font: "Courier New",
          size: SZ_BODY,
          color: "C7254E",
          shading: { type: ShadingType.CLEAR, fill: "F9F2F4" },
        })
      );
    }
    last = m.index + token.length;
  }
  if (last < raw.length) children.push(run(raw.slice(last)));

  return new Paragraph({
    spacing: spacing(0, 100),
    indent: indent ? { left: convertInchesToTwip(indent) } : undefined,
    children,
  });
}

// ── Bullet item ───────────────────────────────────────────────
function bullet(text, level = 0) {
  const children = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) children.push(run(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith("**")) {
      children.push(run(token.slice(2, -2), { bold: true }));
    } else {
      children.push(
        new TextRun({
          text: token.slice(1, -1),
          font: "Courier New",
          size: SZ_BODY,
          color: "C7254E",
        })
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) children.push(run(text.slice(last)));

  return new Paragraph({
    bullet: { level },
    spacing: spacing(0, 60),
    children,
  });
}

// ── Numbered item ─────────────────────────────────────────────
function numbered(text, level = 0) {
  const children = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) children.push(run(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith("**")) {
      children.push(run(token.slice(2, -2), { bold: true }));
    } else {
      children.push(new TextRun({ text: token.slice(1, -1), font: "Courier New", size: SZ_BODY, color: "C7254E" }));
    }
    last = m.index + token.length;
  }
  if (last < text.length) children.push(run(text.slice(last)));

  return new Paragraph({
    numbering: { reference: "numbered-list", level },
    spacing: spacing(0, 60),
    children,
  });
}

// ── Blockquote / callout box ──────────────────────────────────
function callout(text) {
  return new Paragraph({
    spacing: spacing(80, 80),
    indent: { left: convertInchesToTwip(0.3), right: convertInchesToTwip(0.3) },
    shading: { type: ShadingType.CLEAR, fill: "FFF8E1" },
    border: {
      left: { style: BorderStyle.THICK, size: 12, color: "FFC107" },
    },
    children: [
      new TextRun({
        text: text.replace(/^\s*>\s*/, ""),
        font: "Calibri",
        size: SZ_BODY,
        italics: true,
        color: "5D4037",
      }),
    ],
  });
}

// ── Horizontal rule spacer ────────────────────────────────────
function spacer() {
  return new Paragraph({ spacing: spacing(80, 80), children: [run("")] });
}

// ── Table builder (| col | col | col |) ──────────────────────
function buildTable(lines) {
  // lines[0] = header row, lines[1] = separator, lines[2..] = data rows
  const parse = (line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = parse(lines[0]);
  const dataRows = lines.slice(2).map(parse);

  const colCount = headers.length;
  const colWidth = Math.floor(9360 / colCount); // ~6.5 inch page

  const makeCell = (text, isHeader, isAlt) => {
    const fill = isHeader ? TABLE_HDR : isAlt ? TABLE_ROW_ALT : "FFFFFF";
    const textColor = isHeader ? "FFFFFF" : "1A1A2E";
    return new TableCell({
      shading: { type: ShadingType.CLEAR, fill },
      borders: cellBorders(isHeader ? TABLE_HDR : BORDER_CLR),
      margins: {
        top: 80, bottom: 80,
        left: 120, right: 120,
      },
      children: [
        new Paragraph({
          spacing: spacing(0, 0),
          children: [
            new TextRun({
              text,
              font: "Calibri",
              size: SZ_CAPTION,
              bold: isHeader,
              color: textColor,
            }),
          ],
        }),
      ],
    });
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h) => makeCell(h, true, false)),
  });

  const bodyRows = dataRows.map((row, ri) => {
    const alt = ri % 2 === 1;
    return new TableRow({
      children: row.map((cell) => makeCell(cell, false, alt)),
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    margins: { top: 0, bottom: 0 },
  });
}

// ── Cover page ───────────────────────────────────────────────
function coverPage() {
  return [
    new Paragraph({
      spacing: spacing(2000, 0),
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "FuelDesk",
          font: "Calibri",
          size: 96,
          bold: true,
          color: BRAND_BLUE,
        }),
      ],
    }),
    new Paragraph({
      spacing: spacing(100, 0),
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Filling Station Management Platform",
          font: "Calibri",
          size: 36,
          color: "555555",
        }),
      ],
    }),
    new Paragraph({
      spacing: spacing(600, 0),
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Complete User Guide",
          font: "Calibri",
          size: 48,
          bold: true,
          color: HEADING2_CLR,
        }),
      ],
    }),
    new Paragraph({
      spacing: spacing(200, 0),
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Step-by-step instructions for every user — from station owners to attendants",
          font: "Calibri",
          size: SZ_BODY,
          color: "777777",
          italics: true,
        }),
      ],
    }),
    new Paragraph({
      spacing: spacing(1200, 0),
      alignment: AlignmentType.CENTER,
      border: {
        top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_CLR },
      },
      children: [
        new TextRun({
          text: `Version 1.0  ·  ${new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}`,
          font: "Calibri",
          size: SZ_CAPTION,
          color: "999999",
        }),
      ],
    }),
    // Page break
    new Paragraph({
      pageBreakBefore: true,
      children: [run("")],
    }),
  ];
}

// ── Main parse & build ────────────────────────────────────────
function parseMarkdown(md) {
  const lines  = md.split("\n");
  const elems  = [];
  let   i      = 0;
  let   inList = false; // track bullet vs numbered context

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip YAML / front matter fences (unlikely here but safe)
    if (trimmed === "---") { i++; continue; }

    // H1  (#)
    if (/^# (?!#)/.test(trimmed)) {
      // Skip the document title on the cover — already rendered
      const text = trimmed.replace(/^# /, "");
      if (!text.startsWith("FuelDesk —")) {
        elems.push(h1(text));
      }
      i++; continue;
    }

    // H2  (##)
    if (/^## (?!#)/.test(trimmed)) {
      elems.push(spacer());
      elems.push(h2(trimmed.replace(/^## /, "")));
      i++; continue;
    }

    // H3  (###)
    if (/^### (?!#)/.test(trimmed)) {
      elems.push(h3(trimmed.replace(/^### /, "")));
      i++; continue;
    }

    // H4  (####)
    if (/^#### /.test(trimmed)) {
      elems.push(h4(trimmed.replace(/^#### /, "")));
      i++; continue;
    }

    // Table — collect all consecutive table lines
    if (/^\|/.test(trimmed)) {
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 3) {
        elems.push(spacer());
        elems.push(buildTable(tableLines));
        elems.push(spacer());
      }
      continue;
    }

    // Blockquote (>)
    if (/^>/.test(trimmed)) {
      elems.push(callout(trimmed));
      i++; continue;
    }

    // Numbered list (1. 2. 3.)
    if (/^\d+\.\s/.test(trimmed)) {
      const text = trimmed.replace(/^\d+\.\s/, "");
      elems.push(numbered(text));
      i++; continue;
    }

    // Bullet list (- or *)
    if (/^[-*]\s/.test(trimmed)) {
      const text = trimmed.replace(/^[-*]\s/, "");
      // Sub-bullet (indented)
      const indent = line.match(/^(\s+)/)?.[1].length || 0;
      elems.push(bullet(text, indent >= 4 ? 1 : 0));
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      elems.push(spacer());
      i++; continue;
    }

    // Empty line
    if (trimmed === "") {
      i++; continue;
    }

    // Plain paragraph
    elems.push(para(trimmed));
    i++;
  }

  return elems;
}

// ── Assemble document ─────────────────────────────────────────
async function build() {
  const mdPath  = path.join(__dirname, "user-guide.md");
  const outPath = path.join(__dirname, "user-guide.docx");

  const md = fs.readFileSync(mdPath, "utf8");

  const bodyElements = [
    ...coverPage(),
    ...parseMarkdown(md),
  ];

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "numbered-list",
          levels: [
            {
              level: 0,
              format: NumberFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.25) },
                },
                run: { font: "Calibri", size: SZ_BODY },
              },
            },
            {
              level: 1,
              format: NumberFormat.DECIMAL,
              text: "%2.",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
                },
                run: { font: "Calibri", size: SZ_BODY },
              },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: SZ_BODY, color: "1A1A2E" },
          paragraph: { spacing: spacing(0, 100) },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top:    convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left:   convertInchesToTwip(1.25),
              right:  convertInchesToTwip(1.25),
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_CLR },
                },
                spacing: spacing(0, 80),
                children: [
                  new TextRun({
                    text: "FuelDesk  ·  Complete User Guide",
                    font: "Calibri",
                    size: SZ_SMALL,
                    color: "999999",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_CLR },
                },
                spacing: spacing(80, 0),
                children: [
                  new TextRun({
                    text: "Page ",
                    font: "Calibri",
                    size: SZ_SMALL,
                    color: "999999",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: "Calibri",
                    size: SZ_SMALL,
                    color: "999999",
                  }),
                  new TextRun({
                    text: "  of  ",
                    font: "Calibri",
                    size: SZ_SMALL,
                    color: "999999",
                  }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: "Calibri",
                    size: SZ_SMALL,
                    color: "999999",
                  }),
                ],
              }),
            ],
          }),
        },
        children: bodyElements,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);

  const sizeKB = Math.round(buffer.length / 1024);
  console.log("Generated:", outPath, `(${sizeKB} KB)`);
}

build().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
