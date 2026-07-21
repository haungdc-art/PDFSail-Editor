import express from "express";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const exportRouter = express.Router();

exportRouter.post("/export", async (req, res) => {
  try {
    const { fileId, format, blocks } = req.body;

    if (!fileId) {
      return res.status(400).json({ error: "fileId required" });
    }

    // Load the original PDF
    const uploadPath = path.join(__dirname, "..", "uploads", fileId);
    const files = fs.readdirSync(path.join(__dirname, "..", "uploads"));
    const uploadedFile = files.find((f) => f.startsWith(fileId));

    if (!uploadedFile) {
      // Fallback: generate a new PDF
      const newPdf = await PDFDocument.create();
      const page = newPdf.addPage([595, 842]); // A4

      // Add blocks as annotations on the page
      if (blocks && blocks.length > 0) {
        for (const pageData of blocks) {
          for (const block of pageData.blocks || []) {
            if (block.type === "text" && block.content) {
              page.drawText(block.content, {
                x: block.x,
                y: 842 - block.y - block.h,
                size: 14,
                maxWidth: block.w,
              });
            }
          }
        }
      }

      const pdfBytes = await newPdf.save();
      const outputPath = path.join(
        __dirname,
        "..",
        "uploads",
        `export-${fileId}.pdf`
      );
      fs.writeFileSync(outputPath, pdfBytes);

      return res.json({
        url: `/api/file/export-${fileId}.pdf`,
        fileName: `edited-${fileId}.pdf`,
        format: format || "pdf",
      });
    }

    const filePath = path.join(__dirname, "..", "uploads", uploadedFile);
    const fileBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(fileBytes);
    const pages = pdfDoc.getPages();

    // Apply edits to each page
    if (blocks && blocks.length > 0) {
      for (const pageData of blocks) {
        const pageIndex = pageData.pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= pages.length) continue;

        const page = pages[pageIndex];
        const pageHeight = page.getHeight();

        for (const block of pageData.blocks || []) {
          if (block.type === "text" && block.content) {
            page.drawText(block.content, {
              x: block.x,
              y: pageHeight - block.y - block.h,
              size: 14,
              maxWidth: block.w,
            });
          }
        }
      }
    }

    const modifiedPdfBytes = await pdfDoc.save();
    const outputPath = path.join(
      __dirname,
      "..",
      "uploads",
      `export-${fileId}.pdf`
    );
    fs.writeFileSync(outputPath, modifiedPdfBytes);

    res.json({
      url: `/api/file/export-${fileId}.pdf`,
      fileName: `edited-${fileId}.pdf`,
      format: format || "pdf",
    });
  } catch (err: any) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// Serve exported files
exportRouter.get("/file/:filename", (req, res) => {
  const filePath = path.join(__dirname, "..", "uploads", req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: "File not found" });
  }
});
