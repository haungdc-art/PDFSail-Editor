/**
 * translations.ts — Commit 4 +
 *
 * 英语 (en) + 巴西葡萄牙语 (pt-BR) 翻译字典。
 *
 * 组织方式：按 feature/模块分组，key 用点号分隔（如 "toolbar.upload"）。
 * 新增字符串时，在两个语言对象里都加一份。
 */

export type Lang = "en" | "pt";

export const translations = {
  en: {
    // 顶部 Header
    "app.title": "PDFSail Editor",
    // DownloadButton
    "download.button": "⬇ Download",
    "download.preparing": "Preparing your document…",
    "download.uploading": "Uploading to PDFSail…",
    "download.redirecting": "Redirecting to checkout…",
    "download.done": "Complete!",
    // 加载完成弹框（PostLoadModal）
    "postload.title": "What do you want to do next?",
    "postload.subtitle": "Choose an action to get started",
    "postload.editText": "Edit Text",
    "postload.editTextDesc": "Modify text directly on the PDF",
    "postload.compress": "Compress PDF",
    "postload.compressDesc": "Reduce file size for sharing",
    "postload.toWord": "PDF to Word",
    "postload.toWordDesc": "Convert to editable .docx",
    "postload.toJpg": "PDF to JPG",
    "postload.toJpgDesc": "Convert pages to images",
    "postload.close": "Maybe later",
    // MainToolbar
    "toolbar.upload": "📤 Upload",
    "toolbar.pages": "📄 Pages",
    "toolbar.text": "T Text",
    "toolbar.image": "🖼 Image",
    "toolbar.highlight": "🟡 Highlight",
    "toolbar.redact": "⬛ Redact",
    "toolbar.signature": "✍ Signature",
    "toolbar.annotate": "📌 Annotate",
    "toolbar.edit": "✏️ Edit",
    "toolbar.undo": "↩ Undo",
    "toolbar.redo": "↪ Redo",
    "toolbar.ocrPage": "🔍 OCR Page",
    "toolbar.ocrRegion": "🎯 OCR Region",
    "toolbar.ocrBusy": "⏳ OCR...",
    "toolbar.convert": "🔧 Convert ▾",
    "toolbar.compress": "📦 Compress PDF",
    "toolbar.split": "✂️ Split PDF",
    "toolbar.rotate": "🔄 Rotate PDF",
    "toolbar.pageNum": "🔢 Add Page Numbers",
    "toolbar.toWord": "📝 PDF to Word",
    "toolbar.toExcel": "📊 PDF to Excel",
    "toolbar.watermark": "🧹 Remove Watermark",
    "toolbar.merge": "🔗 Merge PDF",
    "toolbar.clear": "🗑 Clear",
    // SignaturePad
    "sig.title": "Add Signature",
    "sig.handwriting": "✍ Handwriting",
    "sig.photo": "📷 Photo",
    "sig.artistic": "✨ Artistic",
    "sig.fullName": "Full Name",
    "sig.color": "Color",
    "sig.style": "Style",
    "sig.useSignature": "Use Signature",
    "sig.cancel": "Cancel",
    "sig.clear": "Clear",
    "sig.choosePhoto": "Choose Photo",
    // 通用
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.close": "Close",
  },
  pt: {
    // 顶部 Header
    "app.title": "Editor PDFSail",
    // DownloadButton
    "download.button": "⬇ Baixar",
    "download.preparing": "Preparando seu documento…",
    "download.uploading": "Enviando para PDFSail…",
    "download.redirecting": "Redirecionando para o pagamento…",
    "download.done": "Concluído!",
    // 加载完成弹框（PostLoadModal）
    "postload.title": "O que você quer fazer agora?",
    "postload.subtitle": "Escolha uma ação para começar",
    "postload.editText": "Editar Texto",
    "postload.editTextDesc": "Modifique o texto diretamente no PDF",
    "postload.compress": "Comprimir PDF",
    "postload.compressDesc": "Reduza o tamanho do arquivo",
    "postload.toWord": "PDF para Word",
    "postload.toWordDesc": "Converter para .docx editável",
    "postload.toJpg": "PDF para JPG",
    "postload.toJpgDesc": "Converter páginas em imagens",
    "postload.close": "Talvez depois",
    // MainToolbar
    "toolbar.upload": "📤 Enviar",
    "toolbar.pages": "📄 Páginas",
    "toolbar.text": "T Texto",
    "toolbar.image": "🖼 Imagem",
    "toolbar.highlight": "🟡 Destaque",
    "toolbar.redact": "⬛ Ocultar",
    "toolbar.signature": "✍ Assinatura",
    "toolbar.annotate": "📌 Anotar",
    "toolbar.edit": "✏️ Editar",
    "toolbar.undo": "↩ Desfazer",
    "toolbar.redo": "↪ Refazer",
    "toolbar.ocrPage": "🔍 OCR Página",
    "toolbar.ocrRegion": "🎯 OCR Região",
    "toolbar.ocrBusy": "⏳ OCR...",
    "toolbar.convert": "🔧 Converter ▾",
    "toolbar.compress": "📦 Comprimir PDF",
    "toolbar.split": "✂️ Dividir PDF",
    "toolbar.rotate": "🔄 Girar PDF",
    "toolbar.pageNum": "🔢 Adicionar Números",
    "toolbar.toWord": "📝 PDF para Word",
    "toolbar.toExcel": "📊 PDF para Excel",
    "toolbar.watermark": "🧹 Remover Marca d'água",
    "toolbar.merge": "🔗 Mesclar PDF",
    "toolbar.clear": "🗑 Limpar",
    // SignaturePad
    "sig.title": "Adicionar Assinatura",
    "sig.handwriting": "✍ Manuscrita",
    "sig.photo": "📷 Foto",
    "sig.artistic": "✨ Artística",
    "sig.fullName": "Nome Completo",
    "sig.color": "Cor",
    "sig.style": "Estilo",
    "sig.useSignature": "Usar Assinatura",
    "sig.cancel": "Cancelar",
    "sig.clear": "Limpar",
    "sig.choosePhoto": "Escolher Foto",
    // 通用
    "common.cancel": "Cancelar",
    "common.confirm": "Confirmar",
    "common.close": "Fechar",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
