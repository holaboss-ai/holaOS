import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createPiHashlineToolDefinitions } from "./pi-hashline-tools.js";

function createPdfBuffer(text: string): Buffer {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 24 Tf\n72 120 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "utf8");
}

async function createDocxBuffer(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function withTempWorkspace(fn: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hashline-tools-"));
  try {
    await fn(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

function firstTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block?.text);
  return block.text;
}

function extractHashlineHeader(text: string): string {
  const header = text.split("\n").find((line) => line.startsWith("¶"));
  assert.ok(header);
  return header;
}

test("hashline read emits snapshot-tagged numbered output", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "example.ts"),
      'const first = 1;\nconst second = 2;\nconst third = 3;\n',
      "utf-8",
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "example.ts", offset: 2, limit: 2 },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶example\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:const second = 2;$/m);
    assert.match(text, /^3:const third = 3;$/m);
  });
});

test("hashline read lists directory entries with pagination support", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.mkdir(path.join(workspaceDir, "docs", "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "docs", "notes.md"), "# notes\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "docs", "todo.txt"), "ship it\n", "utf-8");

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "docs", offset: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Directory: docs\]$/m);
    assert.match(text, /^Entries: 3$/m);
    assert.match(text, /^2:reports\/$/m);
    assert.match(text, /\[Showing entries 2-2 of 3\. Use offset=3 to continue\.\]$/m);
  });
});

test("hashline read extracts PDF content into readable text", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "summary.pdf"), createPdfBuffer("Hello PDF"));

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "summary.pdf" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Document: summary\.pdf\]$/m);
    assert.match(text, /^Mime-Type: application\/pdf$/m);
    assert.match(text, /^1:<pdf filename="summary\.pdf" pages="1">$/m);
    assert.match(text, /Hello PDF/);
  });
});

test("hashline read extracts DOCX content into readable text", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "notes.docx"),
      await createDocxBuffer(["Quarterly plan", "Ship the feature"]),
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "notes.docx" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Document: notes\.docx\]$/m);
    assert.match(text, /^Mime-Type: application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/m);
    assert.match(text, /Quarterly plan/);
    assert.match(text, /Ship the feature/);
  });
});

test("hashline read reports unsupported binary files instead of decoding garbage", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "archive.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "archive.bin" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Binary file: archive\.bin\]$/m);
    assert.match(text, /^Extension: \.bin$/m);
    assert.match(text, /supports text files, directories, images, PDFs, DOCX, PPTX, XLSX, and XLS files\./);
  });
});

test("hashline edit applies anchored patches and returns the next snapshot tag", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "greet.ts");
    await fs.writeFile(
      filePath,
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
      "utf-8",
    );

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "greet.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const header = extractHashlineHeader(firstTextBlock(readResult));
    const editInput = [
      header,
      "1 3",
      "&1",
      '+  if (!name) return "Hello, stranger!";',
      "&2..3",
    ].join("\n");

    const editResult = await editTool.execute(
      "call-2",
      { input: editInput },
      undefined,
      undefined,
      {} as never,
    );

    assert.equal(
      await fs.readFile(filePath, "utf-8"),
      'export function greet(name: string): string {\n  if (!name) return "Hello, stranger!";\n  return `Hello, ${name}!`;\n}\n',
    );
    assert.match(firstTextBlock(editResult), /^Updated greet\.ts\.\nNext snapshot: ¶greet\.ts#[0-9A-F]{3}$/m);
    assert.match(
      String((editResult.details as { diff?: string } | undefined)?.diff ?? ""),
      /\+2   if \(!name\) return "Hello, stranger!";/,
    );
  });
});

test("hashline edit rejects stale snapshot tags after the file changes", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "counter.ts");
    await fs.writeFile(filePath, "let count = 1;\n", "utf-8");

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "counter.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const header = extractHashlineHeader(firstTextBlock(readResult));

    await fs.writeFile(filePath, "let count = 2;\n", "utf-8");

    await assert.rejects(
      editTool.execute(
        "call-2",
        { input: `${header}\n1\n+let count = 3;` },
        undefined,
        undefined,
        {} as never,
      ),
      /Stale hashline snapshot/,
    );
  });
});

test("hashline edit preflights multi-file patches before writing", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const firstPath = path.join(workspaceDir, "first.ts");
    const secondPath = path.join(workspaceDir, "second.ts");
    await fs.writeFile(firstPath, "const first = 1;\n", "utf-8");
    await fs.writeFile(secondPath, "const second = 2;\n", "utf-8");

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const firstHeader = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-1",
      { path: "first.ts" },
      undefined,
      undefined,
      {} as never,
    )));
    const secondHeader = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-2",
      { path: "second.ts" },
      undefined,
      undefined,
      {} as never,
    )));

    await fs.writeFile(secondPath, "const second = 20;\n", "utf-8");

    const multiFilePatch = [
      firstHeader,
      "1",
      "+const first = 10;",
      "",
      secondHeader,
      "1",
      "+const second = 30;",
    ].join("\n");

    await assert.rejects(
      editTool.execute(
        "call-3",
        { input: multiFilePatch },
        undefined,
        undefined,
        {} as never,
      ),
      /Stale hashline snapshot/,
    );
    assert.equal(await fs.readFile(firstPath, "utf-8"), "const first = 1;\n");
  });
});

test("hashline edit tolerates unified-diff replacement rows in the body", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "news.html");
    await fs.writeFile(
      filePath,
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Old News</title></head><body></body></html>\n",
      "utf-8",
    );

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const header = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-1",
      { path: "news.html" },
      undefined,
      undefined,
      {} as never,
    )));

    await editTool.execute(
      "call-2",
      {
        input: [
          header,
          "1 1",
          "-<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Old News</title></head><body></body></html>",
          "+<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Latest Major News Today - May 28, 2026</title></head><body></body></html>",
        ].join("\n"),
      },
      undefined,
      undefined,
      {} as never,
    );

    assert.equal(
      await fs.readFile(filePath, "utf-8"),
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Latest Major News Today - May 28, 2026</title></head><body></body></html>\n",
    );
  });
});

test("hashline edit retroactively strips unified-diff context prefixes", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "snippet.txt");
    await fs.writeFile(
      filePath,
      "alpha\nold section\nstale tail\nomega\n",
      "utf-8",
    );

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const header = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-1",
      { path: "snippet.txt" },
      undefined,
      undefined,
      {} as never,
    )));

    await editTool.execute(
      "call-2",
      {
        input: [
          header,
          "2 3",
          " keep this line",
          "+fresh tail",
          "-stale tail",
        ].join("\n"),
      },
      undefined,
      undefined,
      {} as never,
    );

    assert.equal(
      await fs.readFile(filePath, "utf-8"),
      "alpha\nkeep this line\nfresh tail\nomega\n",
    );
  });
});
