import { useEffect, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { GitCommitInfo, GitCommitLogResult, GitCommitFileInfo } from "../api.js";
import { DiffViewer } from "./DiffViewer.js";

const PAGE_SIZE = 20;

export function CommitHistoryPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const selectedHash = useStore((s) => s.commitSelectedHash.get(sessionId) ?? null);
  const selectedFile = useStore((s) => s.commitSelectedFile.get(sessionId) ?? null);
  const setSelectedHash = useStore((s) => s.setCommitSelectedHash);
  const setSelectedFile = useStore((s) => s.setCommitSelectedFile);

  const cwd = session?.cwd || sdkSession?.cwd;

  const [logResult, setLogResult] = useState<GitCommitLogResult | null>(null);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Map<string, GitCommitFileInfo[]>>(new Map());
  const [diffContent, setDiffContent] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 640 : true,
  );

  // Fetch commit log on mount
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setLoading(true);
    api.getCommitLog(cwd, { limit: PAGE_SIZE, offset: 0 })
      .then((result) => {
        if (cancelled) return;
        setLogResult(result);
        setCommits(result.commits);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cwd]);

  // Load more commits
  const loadMore = useCallback(() => {
    if (!cwd || loadingMore) return;
    setLoadingMore(true);
    api.getCommitLog(cwd, { limit: PAGE_SIZE, offset: commits.length })
      .then((result) => {
        setCommits((prev) => [...prev, ...result.commits]);
        setLogResult(result);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [cwd, commits.length, loadingMore]);

  // Toggle commit expansion and fetch file list
  const toggleCommit = useCallback((hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(hash);

    // Fetch file list if not cached
    if (!commitFiles.has(hash) && cwd) {
      api.getCommitDetail(cwd, hash)
        .then((detail) => {
          setCommitFiles((prev) => {
            const next = new Map(prev);
            next.set(hash, detail.files);
            return next;
          });
        })
        .catch(() => {});
    }
  }, [expandedHash, commitFiles, cwd]);

  // Fetch diff when a file is selected
  useEffect(() => {
    if (!cwd || !selectedHash || !selectedFile) {
      setDiffContent("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api.getCommitDetail(cwd, selectedHash, selectedFile)
      .then((detail) => {
        if (!cancelled) {
          setDiffContent(detail.diff);
          setDiffLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffContent("");
          setDiffLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [cwd, selectedHash, selectedFile]);

  const handleFileClick = useCallback((hash: string, filePath: string) => {
    setSelectedHash(sessionId, hash);
    setSelectedFile(sessionId, filePath);
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      setSidebarOpen(false);
    }
  }, [sessionId, setSelectedHash, setSelectedFile]);

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-cc-muted text-sm">Waiting for session to initialize...</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">No commits found</p>
          <p className="text-xs text-cc-muted leading-relaxed">
            Commits made during this session will appear here.
          </p>
        </div>
      </div>
    );
  }

  const hasMore = logResult ? commits.length < logResult.total : false;
  const scopeLabel = logResult?.scope === "branch"
    ? `${commits.length} commit${commits.length !== 1 ? "s" : ""} ahead of ${logResult.baseBranch}`
    : "Recent commits";

  return (
    <div className="h-full flex bg-cc-bg relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-20 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Commit list sidebar */}
      <div
        className={`
          ${sidebarOpen ? "w-[280px] translate-x-0" : "w-0 -translate-x-full"}
          fixed sm:relative z-30 sm:z-auto
          ${sidebarOpen ? "sm:w-[280px]" : "sm:w-0 sm:-translate-x-full"}
          shrink-0 h-full flex flex-col bg-cc-sidebar border-r border-cc-border transition-all duration-200 overflow-hidden
        `}
      >
        <div className="w-[280px] px-4 py-3 text-[11px] font-semibold text-cc-muted uppercase tracking-wider border-b border-cc-border shrink-0 flex items-center justify-between">
          <span>{scopeLabel}</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-5 h-5 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer sm:hidden"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {commits.map((commit) => {
            const isExpanded = expandedHash === commit.hash;
            const files = commitFiles.get(commit.hash) || [];

            return (
              <div key={commit.hash}>
                <button
                  onClick={() => toggleCommit(commit.hash)}
                  className={`flex flex-col w-full mx-1 px-2 py-2 text-left rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer ${
                    isExpanded ? "bg-cc-active" : ""
                  }`}
                  style={{ width: "calc(100% - 8px)" }}
                >
                  <div className="flex items-center gap-2 w-full">
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 shrink-0 text-cc-muted transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-mono-code text-cc-primary shrink-0">{commit.hashShort}</span>
                    <span className="text-[13px] text-cc-fg truncate flex-1">{commit.subject}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 ml-[18px]">
                    {commit.insertions > 0 && (
                      <span className="text-[10px] text-green-500 font-mono-code">+{commit.insertions}</span>
                    )}
                    {commit.deletions > 0 && (
                      <span className="text-[10px] text-red-500 font-mono-code">-{commit.deletions}</span>
                    )}
                    {commit.filesChanged > 0 && (
                      <span className="text-[10px] text-cc-muted">
                        {commit.filesChanged} file{commit.filesChanged !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </button>

                {/* Expanded file list */}
                {isExpanded && (
                  <div className="ml-[26px] mr-1 mb-1">
                    {files.length === 0 ? (
                      <div className="py-1 px-2">
                        <div className="w-3 h-3 border border-cc-muted border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : (
                      files.map((f) => (
                        <button
                          key={f.path}
                          onClick={() => handleFileClick(commit.hash, f.path)}
                          className={`flex items-center gap-2 w-full px-2 py-1 text-[12px] rounded-md hover:bg-cc-hover transition-colors cursor-pointer ${
                            selectedHash === commit.hash && selectedFile === f.path
                              ? "bg-cc-active text-cc-fg"
                              : "text-cc-fg/70"
                          }`}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-cc-muted shrink-0">
                            <path
                              fillRule="evenodd"
                              d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                              clipRule="evenodd"
                            />
                          </svg>
                          <span className="truncate flex-1 font-mono-code">{f.path}</span>
                          <span className="text-[10px] shrink-0">
                            {f.insertions > 0 && <span className="text-green-500">+{f.insertions}</span>}
                            {f.insertions > 0 && f.deletions > 0 && <span className="text-cc-muted">/</span>}
                            {f.deletions > 0 && <span className="text-red-500">-{f.deletions}</span>}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Load more button */}
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-2 text-[12px] text-cc-primary hover:text-cc-fg transition-colors cursor-pointer disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load more..."}
            </button>
          )}
        </div>
      </div>

      {/* Diff area */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Top bar */}
        {selectedFile && (
          <div className="shrink-0 flex items-center gap-2 sm:gap-2.5 px-2 sm:px-4 py-2.5 bg-cc-card border-b border-cc-border">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="flex items-center justify-center w-6 h-6 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                title="Show commit list"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-cc-fg text-[13px] font-medium truncate block">
                {selectedFile.split("/").pop()}
              </span>
              <span className="text-cc-muted truncate text-[11px] hidden sm:block font-mono-code">
                {selectedFile}
              </span>
            </div>
            <span className="text-cc-muted text-[11px] shrink-0 hidden sm:inline font-mono-code">
              {selectedHash?.slice(0, 7)}
            </span>
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-auto">
          {diffLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : selectedFile ? (
            <div className="p-4">
              <DiffViewer unifiedDiff={diffContent} fileName={selectedFile} mode="full" />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  Show commit list
                </button>
              )}
              <p className="text-cc-muted text-sm">Select a commit and file to view changes</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
