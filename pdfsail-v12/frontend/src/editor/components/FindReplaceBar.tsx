/**
 * FindReplaceBar — V12 + Bug 12/14 fixes
 *
 * 文本查找与替换面板：
 *   - Find: 输入文字 → 高亮所有匹配的 segment
 *   - Replace: 替换当前匹配
 *   - Replace All: 替换所有匹配
 *   - 上一个 / 下一个：在多个匹配间导航
 *   - Bug 12: 大小写敏感、Replace、Replace All 全部生效；激光扫描动画；高亮替换后的文本
 *   - Bug 14: Replace 后页面文本立即高亮显示修改后的文本
 *
 * 匹配逻辑：遍历 segments，对每个 segment.text 做 indexOf 查找，
 * 记录匹配位置（segmentId + offset）。
 *
 * 替换通过 handleSegmentChange 写回，同时同步到 docBlocks（与 FloatingToolbar 一致）。
 * 替换后 segments 更新 → EditableTextNode 的 isModified 为 true → 自动黄色高亮。
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";

interface Match {
  segmentId: string;
  start: number;
  end: number;
}

export function FindReplaceBar({ onClose }: { onClose: () => void }) {
  const { segments, handleSegmentChange, setBlocks, page } = useEditor();
  const { t } = useI18n();
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  // Bug 12: 激光扫描动画状态
  const [scanning, setScanning] = useState(false);
  // Bug 14: 刚替换过的 segment ID 列表，用于触发高亮动画
  const [replacedSegmentIds, setReplacedSegmentIds] = useState<string[]>([]);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 计算所有匹配
  const matches = useMemo<Match[]>(() => {
    if (!findText) return [];
    const result: Match[] = [];
    const needle = caseSensitive ? findText : findText.toLowerCase();
    for (const seg of segments) {
      const hay = caseSensitive ? seg.text : seg.text.toLowerCase();
      let from = 0;
      while (true) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        result.push({ segmentId: seg.id, start: idx, end: idx + findText.length });
        from = idx + findText.length;
      }
    }
    return result;
  }, [findText, segments, caseSensitive]);

  // findText 变化时重置 currentIdx
  useEffect(() => {
    setCurrentIdx(0);
  }, [findText]);

  // 清理扫描动画定时器
  useEffect(() => {
    return () => {
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, []);

  const currentMatch = matches[currentIdx];

  /**
   * Bug 12: 触发激光扫描动画。
   * 动画持续 600ms，期间显示扫描线从上到下扫过画布。
   */
  const triggerScanAnimation = useCallback(() => {
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    setScanning(true);
    scanTimerRef.current = setTimeout(() => {
      setScanning(false);
    }, 600);
  }, []);

  // 同步 segment 修改到 docBlocks（与 FloatingToolbar / PDFCanvas 中的逻辑一致）
  const syncToBlocks = useCallback((segId: string, newText: string, seg: any) => {
    const blockId = `seg_block_${segId}`;
    setBlocks((prev) => {
      const existingIdx = prev.findIndex((b) => b.id === blockId);
      const newBlock = {
        id: blockId, type: "text" as const, page,
        x: seg.cssX, y: seg.cssY, w: seg.cssW, h: seg.cssH,
        text: newText, fontSize: seg.font.size,
        fontFamily: seg.font.family, color: seg.font.color,
      };
      if (existingIdx >= 0) {
        return prev.map((b, i) => (i === existingIdx ? { ...b, text: newText } : b));
      }
      return [...prev, newBlock];
    });
  }, [setBlocks, page]);

  // 替换当前匹配
  const replaceCurrent = useCallback(() => {
    if (!currentMatch) return;
    triggerScanAnimation();
    const seg = segments.find((s) => s.id === currentMatch.segmentId);
    if (!seg) return;
    const updated = seg.text.slice(0, currentMatch.start) + replaceText + seg.text.slice(currentMatch.end);
    handleSegmentChange(seg.id, updated);
    syncToBlocks(seg.id, updated, seg);
    // Bug 14: 标记刚替换的 segment，触发高亮动画
    setReplacedSegmentIds((prev) => [...prev, seg.id]);
    // 替换后跳到下一个匹配（如果还有）
    if (currentIdx >= matches.length - 1) {
      setCurrentIdx(Math.max(0, matches.length - 2));
    }
  }, [currentMatch, segments, replaceText, handleSegmentChange, syncToBlocks, currentIdx, matches.length, triggerScanAnimation]);

  // 替换全部
  const replaceAll = useCallback(() => {
    if (!findText || matches.length === 0) return;
    triggerScanAnimation();
    // 按 segmentId 分组，每个 segment 一次性替换所有匹配
    const bySeg = new Map<string, Match[]>();
    for (const m of matches) {
      const list = bySeg.get(m.segmentId) ?? [];
      list.push(m);
      bySeg.set(m.segmentId, list);
    }
    const replacedIds: string[] = [];
    for (const [segId, list] of bySeg) {
      const seg = segments.find((s) => s.id === segId);
      if (!seg) continue;
      // 从后向前替换，避免 offset 漂移
      const sorted = [...list].sort((a, b) => b.start - a.start);
      let text = seg.text;
      for (const m of sorted) {
        text = text.slice(0, m.start) + replaceText + text.slice(m.end);
      }
      handleSegmentChange(segId, text);
      syncToBlocks(segId, text, seg);
      replacedIds.push(segId);
    }
    // Bug 14: 标记所有刚替换的 segment
    setReplacedSegmentIds(replacedIds);
  }, [findText, matches, segments, replaceText, handleSegmentChange, syncToBlocks, triggerScanAnimation]);

  const goPrev = () => {
    triggerScanAnimation();
    setCurrentIdx((i) => (i - 1 + matches.length) % matches.length);
  };
  const goNext = () => {
    triggerScanAnimation();
    setCurrentIdx((i) => (i + 1) % matches.length);
  };

  return (
    <>
      <div
        style={{
          background: "#0e1422",
          border: "1px solid #2a2a4a",
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 12,
          color: "#e0e0e0",
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ fontSize: 11, color: "#94a3b8", minWidth: 36 }}>{t("find.find")}</label>
          <input
            autoFocus
            type="text"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goNext();
              if (e.key === "Escape") onClose();
            }}
            placeholder={t("find.findPlaceholder")}
            style={{
              padding: "5px 10px", width: 180,
              background: "#0f0f23", color: "#e0e0e0",
              border: "1px solid #2a2a4a", borderRadius: 4,
              fontSize: 12, outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ fontSize: 11, color: "#94a3b8", minWidth: 50 }}>{t("find.replace")}</label>
          <input
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder={t("find.replacePlaceholder")}
            style={{
              padding: "5px 10px", width: 180,
              background: "#0f0f23", color: "#e0e0e0",
              border: "1px solid #2a2a4a", borderRadius: 4,
              fontSize: 12, outline: "none",
            }}
          />
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => {
              setCaseSensitive(e.target.checked);
              triggerScanAnimation();
            }}
          />
          {t("find.caseSensitive")}
        </label>

        <div style={{ width: 1, height: 20, background: "#2a2a4a" }} />

        {matches.length > 0 && (
          <span style={{ fontSize: 11, color: "#8ab4f8", fontWeight: 600 }}>
            {currentIdx + 1} / {matches.length}
          </span>
        )}
        {matches.length === 0 && findText && (
          <span style={{ fontSize: 11, color: "#94a3b8" }}>
            0 {t("find.matches")}
          </span>
        )}

        <button
          onClick={goPrev}
          disabled={matches.length === 0}
          style={navBtnStyle(matches.length === 0)}
        >
          {t("find.prev")}
        </button>
        <button
          onClick={goNext}
          disabled={matches.length === 0}
          style={navBtnStyle(matches.length === 0)}
        >
          {t("find.next")}
        </button>

        <button
          onClick={replaceCurrent}
          disabled={!currentMatch}
          style={actionBtnStyle(!currentMatch, "#6366f1")}
        >
          {t("find.replaceBtn")}
        </button>
        <button
          onClick={replaceAll}
          disabled={matches.length === 0}
          style={actionBtnStyle(matches.length === 0, "#10b981")}
        >
          {t("find.replaceAllBtn")}
        </button>

        <div style={{ flex: 1 }} />

        {scanning && (
          <span style={{ fontSize: 11, color: "#8ab4f8", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              display: "inline-block",
              width: 10, height: 10,
              border: "2px solid #8ab4f8", borderTopColor: "transparent",
              borderRadius: "50%", animation: "spin 0.6s linear infinite",
            }} />
            <span>{t("find.scanning")}</span>
          </span>
        )}

        <button
          onClick={onClose}
          style={{
            background: "transparent", color: "#94a3b8",
            border: "1px solid #2a2a4a", borderRadius: 4,
            padding: "4px 8px", cursor: "pointer", fontSize: 12,
          }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {/* Bug 12: 激光扫描动画 overlay */}
      {scanning && <LaserScanOverlay />}

      {/* 当前匹配高亮提示 */}
      {currentMatch && (
        <CurrentMatchHighlight segmentId={currentMatch.segmentId} />
      )}

      {/* Bug 14: 替换后的 segment 立即高亮 */}
      {replacedSegmentIds.map((segId) => (
        <ReplacedHighlight key={segId} segmentId={segId} onDone={() => {
          setReplacedSegmentIds((prev) => prev.filter((id) => id !== segId));
        }} />
      ))}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function navBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 8px",
    background: disabled ? "#1a1a3a" : "#1a1a3a",
    color: disabled ? "#4a4a6a" : "#e0e0e0",
    border: "1px solid #2a2a4a",
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
  };
}

function actionBtnStyle(disabled: boolean, color: string): React.CSSProperties {
  return {
    padding: "5px 12px",
    background: disabled ? "transparent" : `${color}22`,
    color: disabled ? "#4a4a6a" : color,
    border: `1px solid ${disabled ? "#2a2a4a" : `${color}55`}`,
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 11,
    fontWeight: 600,
  };
}

/**
 * Bug 12: 激光扫描动画 —— 一条绿色激光线从画布顶部扫到底部。
 * 使用 fixed 定位覆盖整个视口，pointer-events: none 不影响交互。
 */
function LaserScanOverlay() {
  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: "100vh",
          pointerEvents: "none",
          zIndex: 9998,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            height: 3,
            background: "linear-gradient(90deg, transparent, #4ade80 20%, #8ab4f8 50%, #4ade80 80%, transparent)",
            boxShadow: "0 0 20px #4ade80, 0 0 40px rgba(74,222,128,0.5)",
            animation: "laserScan 0.6s ease-in-out",
            top: 0,
          }}
        />
      </div>
      <style>{`
        @keyframes laserScan {
          0% { top: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { top: 100vh; opacity: 0; }
        }
      `}</style>
    </>
  );
}

// 当前匹配的视觉提示：滚动到对应 segment 并加黄色边框
function CurrentMatchHighlight({ segmentId }: { segmentId: string }) {
  useEffect(() => {
    const elem = document.querySelector(`[data-segment-id="${segmentId}"]`) as HTMLElement | null;
    if (!elem) return;
    elem.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const prevBorder = elem.style.border;
    const prevBackground = elem.style.background;
    elem.style.border = "2px solid #facc15";
    elem.style.background = "rgba(250,204,21,0.15)";
    const timer = setTimeout(() => {
      elem.style.border = prevBorder;
      elem.style.background = prevBackground;
    }, 1500);
    return () => {
      clearTimeout(timer);
      elem.style.border = prevBorder;
      elem.style.background = prevBackground;
    };
  }, [segmentId]);
  return null;
}

/**
 * Bug 14: 替换后的 segment 立即高亮 —— 绿色脉冲动画提示用户文本已被替换。
 * 由于 segments 始终渲染（Bug 11 fix），替换后的 isModified=true 会自动显示黄色高亮。
 * 这个组件额外添加一个绿色脉冲效果，持续 2 秒后消失。
 */
function ReplacedHighlight({ segmentId, onDone }: { segmentId: string; onDone: () => void }) {
  useEffect(() => {
    const elem = document.querySelector(`[data-segment-id="${segmentId}"]`) as HTMLElement | null;
    if (!elem) {
      const timer = setTimeout(onDone, 500);
      return () => clearTimeout(timer);
    }
    // 滚动到可见区域
    elem.scrollIntoView({ behavior: "smooth", block: "center" });
    // 添加绿色脉冲动画 class
    elem.style.animation = "replacedPulse 2s ease-out";
    const timer = setTimeout(() => {
      elem.style.animation = "";
      onDone();
    }, 2000);
    return () => {
      clearTimeout(timer);
      elem.style.animation = "";
    };
  }, [segmentId, onDone]);
  return (
    <style>{`
      @keyframes replacedPulse {
        0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.6); }
        30% { box-shadow: 0 0 0 8px rgba(74,222,128,0.4); }
        60% { box-shadow: 0 0 0 4px rgba(250,204,21,0.5); }
        100% { box-shadow: 0 0 0 0 rgba(250,204,21,0); }
      }
    `}</style>
  );
}
