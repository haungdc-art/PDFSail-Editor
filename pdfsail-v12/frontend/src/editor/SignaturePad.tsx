import React, { useRef, useState } from "react";

export default function SignaturePad({
  onSave,
  onCancel,
}: {
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"handwriting" | "photo" | "artistic">("handwriting");
  const [artText, setArtText] = useState("John Doe");
  const [artColor, setArtColor] = useState("#1e293b");
  const [artFont, setArtFont] = useState("'Dancing Script', cursive");
  const [photoData, setPhotoData] = useState("");
  const [fontPage, setFontPage] = useState(0);
  const FONTS_PER_PAGE = 5;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const artCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);

  const startDraw = (e: React.MouseEvent) => {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };

  const draw = (e: React.MouseEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#000";
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const stopDraw = () => { drawing.current = false; };
  const clear = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const renderArtistic = () => {
    const canvas = artCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `64px ${artFont}`;
    ctx.fillStyle = artColor;
    ctx.textBaseline = "middle";
    ctx.fillText(artText, 20, canvas.height / 2);
  };

  React.useEffect(() => { renderArtistic(); }, [artText, artColor, artFont]);

  const handleSave = () => {
    if (mode === "handwriting") onSave(canvasRef.current?.toDataURL() || "");
    else if (mode === "artistic") onSave(artCanvasRef.current?.toDataURL() || "");
    else if (mode === "photo") {
      if (!photoData) return;
      onSave(photoData);
    }
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onerror = () => { console.error("File read failed"); };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") setPhotoData(result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const colors = ["#1e293b", "#0f172a", "#334155", "#475569", "#2563eb", "#3b82f6", "#0d9488", "#059669", "#dc2626", "#b91c1c", "#ea580c", "#d97706", "#7c3aed", "#6d28d9", "#db2777", "#be185d"];
  const fonts = [
    { label: "Dancing Script", value: "'Dancing Script', cursive" },
    { label: "Great Vibes", value: "'Great Vibes', cursive" },
    { label: "Parisienne", value: "'Parisienne', cursive" },
    { label: "Allura", value: "'Allura', cursive" },
    { label: "Alex Brush", value: "'Alex Brush', cursive" },
    { label: "Tangerine", value: "'Tangerine', cursive" },
    { label: "Pacifico", value: "'Pacifico', cursive" },
    { label: "Satisfy", value: "'Satisfy', cursive" },
    { label: "Caveat", value: "'Caveat', cursive" },
    { label: "Marck Script", value: "'Marck Script', cursive" },
    { label: "Kaushan Script", value: "'Kaushan Script', cursive" },
    { label: "Lobster Two", value: "'Lobster Two', cursive" },
    { label: "Playball", value: "'Playball', cursive" },
    { label: "Qwigley", value: "'Qwigley', cursive" },
    { label: "Rouge Script", value: "'Rouge Script', cursive" },
    { label: "Damion", value: "'Damion', cursive" },
    { label: "Euphoria Script", value: "'Euphoria Script', cursive" },
    { label: "Pinyon Script", value: "'Pinyon Script', cursive" },
    { label: "Princess Sofia", value: "'Princess Sofia', cursive" },
    { label: "Rochester", value: "'Rochester', cursive" },
    { label: "WindSong", value: "'WindSong', cursive" },
    { label: "Water Brush", value: "'Water Brush', cursive" },
    { label: "Mea Culpa", value: "'Mea Culpa', cursive" },
    { label: "Mr De Haviland", value: "'Mr De Haviland', cursive" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 480, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18, color: "#1e293b" }}>Add Signature</h3>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, background: "#f1f5f9", borderRadius: 8, padding: 4 }}>
          {(["handwriting", "photo", "artistic"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "none", background: mode === m ? "#fff" : "transparent", color: mode === m ? "#1e293b" : "#64748b", fontWeight: mode === m ? 600 : 500, cursor: "pointer", boxShadow: mode === m ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}>
              {m === "handwriting" ? "✍ Handwriting" : m === "photo" ? "📷 Photo" : "✨ Artistic"}
            </button>
          ))}
        </div>

        {mode === "handwriting" && (
          <>
            <canvas ref={canvasRef} width={400} height={200} onMouseDown={startDraw} onMouseMove={draw} onMouseUp={stopDraw} onMouseLeave={stopDraw} style={{ border: "1px solid #cbd5e1", borderRadius: 8, cursor: "crosshair", background: "#fff", width: "100%" }} />
            <button onClick={clear} style={{ marginTop: 8, ...sigBtn }}>Clear</button>
          </>
        )}

        {mode === "photo" && (
          <div style={{ border: "2px dashed #cbd5e1", borderRadius: 8, padding: 32, textAlign: "center" }}>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} style={{ display: "none" }} />
            <button onClick={() => fileInputRef.current?.click()} style={{ ...sigBtn, background: "#3b82f6", color: "#fff" }}>Choose Photo</button>
            {photoData && <img src={photoData} alt="signature" style={{ display: "block", maxWidth: "100%", maxHeight: 160, marginTop: 12, border: "1px solid #e2e8f0", borderRadius: 4 }} />}
          </div>
        )}

        {mode === "artistic" && (
          <>
            <label style={{ fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" }}>Full Name</label>
            <input value={artText} onChange={(e) => setArtText(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #e2e8f0", marginBottom: 12, fontSize: 14 }} />

            <label style={{ fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" }}>Color</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 12 }}>
              {colors.map((c) => (
                <button key={c} onClick={() => setArtColor(c)} style={{ width: "100%", aspectRatio: "1", borderRadius: 4, border: artColor === c ? "2px solid #1e293b" : "1px solid #e2e8f0", background: c, cursor: "pointer" }} />
              ))}
            </div>

            <label style={{ fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" }}>Style</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
              {fonts.slice(fontPage * FONTS_PER_PAGE, (fontPage + 1) * FONTS_PER_PAGE).map((f) => (
                <button key={f.value} onClick={() => setArtFont(f.value)} style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderRadius: 6, border: artFont === f.value ? "2px solid #3b82f6" : "1px solid #e2e8f0", background: artFont === f.value ? "#eff6ff" : "#fff", cursor: "pointer" }}>
                  <div style={{ width: 16, height: 16, borderRadius: 8, border: "2px solid #3b82f6", background: artFont === f.value ? "#3b82f6" : "transparent" }} />
                  <span style={{ fontFamily: f.value, fontSize: 24, color: artColor }}>Signature</span>
                </button>
              ))}
            </div>
            {(() => {
              const totalPages = Math.ceil(fonts.length / FONTS_PER_PAGE);
              if (totalPages <= 1) return null;
              return (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12 }}>
                  <button
                    onClick={() => setFontPage((p) => Math.max(0, p - 1))}
                    disabled={fontPage === 0}
                    style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #e2e8f0", background: fontPage === 0 ? "#f8fafc" : "#fff", color: fontPage === 0 ? "#cbd5e1" : "#1e293b", cursor: fontPage === 0 ? "not-allowed" : "pointer", fontSize: 12 }}
                  >
                    ← Prev
                  </button>
                  <span style={{ fontSize: 12, color: "#64748b", minWidth: 40, textAlign: "center" }}>
                    {fontPage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setFontPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={fontPage === totalPages - 1}
                    style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #e2e8f0", background: fontPage === totalPages - 1 ? "#f8fafc" : "#fff", color: fontPage === totalPages - 1 ? "#cbd5e1" : "#1e293b", cursor: fontPage === totalPages - 1 ? "not-allowed" : "pointer", fontSize: 12 }}
                  >
                    Next →
                  </button>
                </div>
              );
            })()}

            <canvas ref={artCanvasRef} width={440} height={80} style={{ border: "1px solid #e2e8f0", borderRadius: 8, width: "100%", background: "#fff" }} />
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
          <button onClick={handleSave} style={{ ...sigBtn, background: "#3b82f6", color: "#fff" }}>Use Signature</button>
          <button onClick={onCancel} style={{ ...sigBtn, color: "#ef4444" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const sigBtn: React.CSSProperties = {
  padding: "8px 20px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
};
