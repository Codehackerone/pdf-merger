"use client";

import { useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";

type Item = {
  id: string;
  file: File;
  pages: number | null; // null = could not be read
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let nextId = 0;

async function countPages(file: File): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputName, setOutputName] = useState("merged");
  const inputRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | File[]) {
    setError(null);
    const pdfs = Array.from(list).filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (pdfs.length === 0) {
      setError("Only PDF files can be added.");
      return;
    }
    const added = await Promise.all(
      pdfs.map(async (file) => ({
        id: String(nextId++),
        file,
        pages: await countPages(file),
      })),
    );
    setItems((prev) => [...prev, ...added]);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function merge() {
    setError(null);
    setMerging(true);
    try {
      const out = await PDFDocument.create();
      for (const item of items) {
        const src = await PDFDocument.load(await item.file.arrayBuffer(), {
          ignoreEncryption: true,
        });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      const bytes = await out.save();
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${outputName.trim() || "merged"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      console.error(e);
      setError("Merge failed. One of the files may be corrupted or password-protected.");
    } finally {
      setMerging(false);
    }
  }

  const unreadable = items.some((i) => i.pages === null);
  const totalPages = items.reduce((n, i) => n + (i.pages ?? 0), 0);
  const canMerge = items.length >= 2 && !unreadable && !merging;

  return (
    <main className="wrap">
      <header>
        <h1>PDF Merger</h1>
        <p className="sub">
          Combine PDFs in your browser. Your files never leave your device.
        </p>
      </header>

      <div
        className={`drop ${dragOver ? "over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          if (dragIndex !== null) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (dragIndex !== null) return;
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <strong className="pointer-only">Drop PDFs here</strong>
        <span className="pointer-only">or click to choose files</span>
        <strong className="touch-only">Tap to choose PDFs</strong>
        <span className="touch-only">Select several at once to merge them</span>
      </div>

      {error && <p className="error">{error}</p>}

      {items.length > 0 && (
        <>
          <ol className="list">
            {items.map((item, i) => (
              <li
                key={item.id}
                draggable
                className={dragIndex === i ? "dragging" : ""}
                onDragStart={() => setDragIndex(i)}
                onDragEnd={() => setDragIndex(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dragIndex !== i) {
                    move(dragIndex, i);
                    setDragIndex(i);
                  }
                }}
              >
                <span className="handle" aria-hidden>⋮⋮</span>
                <span className="num">{i + 1}</span>
                <div className="meta">
                  <span className="name" title={item.file.name}>{item.file.name}</span>
                  <span className="info">
                    {item.pages === null ? (
                      <span className="bad">Can't read this file</span>
                    ) : (
                      `${item.pages} page${item.pages === 1 ? "" : "s"}`
                    )}
                    {" · "}
                    {formatSize(item.file.size)}
                  </span>
                </div>
                <div className="actions">
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label="Move down">↓</button>
                  <button onClick={() => remove(item.id)} aria-label="Remove">✕</button>
                </div>
              </li>
            ))}
          </ol>

          <div className="footer">
            <label className="filename">
              <input value={outputName} onChange={(e) => setOutputName(e.target.value)} />
              <span>.pdf</span>
            </label>
            <button className="clear" onClick={() => setItems([])}>Clear</button>
            <button className="primary" onClick={merge} disabled={!canMerge}>
              {merging ? "Merging…" : `Merge ${items.length} files · ${totalPages} pages`}
            </button>
          </div>
          {items.length < 2 && <p className="hint">Add at least two PDFs to merge.</p>}
          {unreadable && <p className="hint">Remove files that can't be read before merging.</p>}
        </>
      )}
    </main>
  );
}
