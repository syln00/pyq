"use client";

import { useEffect, useRef, useState } from "react";
import { ImageIcon, Library, Loader2, Upload, X } from "lucide-react";
import LyricEditor from "@/components/LyricEditor";
import MediaPicker, { type PickerMediaItem } from "@/components/MediaPicker";
import { apiFetch, getToken } from "@/lib/api-fetch";
import { AUDIO_FILE_ACCEPT, LYRIC_FILE_ACCEPT, uploadDirect, type UploadedMedia } from "@/lib/upload";
import { parseAudioMetadata } from "@/lib/music-metadata";

export interface MusicTrackDraft {
  audio: PickerMediaItem | UploadedMedia | null;
  cover: PickerMediaItem | UploadedMedia | null;
  lyricMedia: PickerMediaItem | UploadedMedia | null;
  title: string;
  artist: string;
  lrc: string;
}

export interface EditableTrack {
  id: string;
  audioMediaId: string;
  coverMediaId: string | null;
  lyricMediaId: string | null;
  lyricFilename?: string;
  name: string;
  artist: string;
  mp3url: string;
  cover: string;
  lrc: string;
}

interface MusicTrackFormProps {
  track?: EditableTrack | null;
  onSaved: (track: EditableTrack) => void;
  onCancel?: () => void;
}

function mediaFromTrack(track: EditableTrack, kind: "audio" | "image"): PickerMediaItem | null {
  const id = kind === "audio" ? track.audioMediaId : track.coverMediaId;
  const url = kind === "audio" ? track.mp3url : track.cover;
  if (!id || !url) return null;
  return {
    id,
    filename: kind === "audio" ? track.name : "当前封面",
    url,
    storageType: "r2",
    mimeType: kind === "audio" ? "audio/mpeg" : "image/jpeg",
    size: 0,
    category: kind,
    kind,
    createdAt: "",
  };
}

function draftFromTrack(track?: EditableTrack | null): MusicTrackDraft {
  if (!track) return { audio: null, cover: null, lyricMedia: null, title: "", artist: "", lrc: "" };
  return {
    audio: mediaFromTrack(track, "audio"),
    cover: mediaFromTrack(track, "image"),
    lyricMedia: track.lyricMediaId ? {
      id: track.lyricMediaId,
      filename: track.lyricFilename || "当前歌词",
      url: "",
      storageType: "r2",
      mimeType: "text/plain",
      size: 0,
      category: "file",
      kind: "lyric",
      createdAt: "",
    } : null,
    title: track.name,
    artist: track.artist,
    lrc: track.lrc || "",
  };
}

export default function MusicTrackForm({ track, onSaved, onCancel }: MusicTrackFormProps) {
  const [draft, setDraft] = useState<MusicTrackDraft>(() => draftFromTrack(track));
  const [embeddedCover, setEmbeddedCover] = useState<File | null>(null);
  const [picker, setPicker] = useState<"audio" | "cover" | "lyric" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const previousTrackId = useRef(track?.id);

  useEffect(() => {
    if (previousTrackId.current === track?.id) return;
    previousTrackId.current = track?.id;
    Promise.resolve().then(() => {
      setDraft(draftFromTrack(track));
      setEmbeddedCover(null);
      setMessage("");
    });
  }, [track]);

  const token = () => {
    const value = getToken();
    if (!value) throw new Error("登录状态已失效");
    return value;
  };

  const handleAudioFile = async (file: File) => {
    setBusy(true); setMessage("正在解析音乐信息并上传到 S3…");
    try {
      const metadata = await parseAudioMetadata(file);
      const audio = await uploadDirect(file, token(), "audio");
      setDraft((current) => ({ ...current, audio, title: current.title || metadata.title || audio.filename.replace(/\.[^.]+$/, ""), artist: current.artist || metadata.artist || "" }));
      setEmbeddedCover(metadata.artwork || null);
      setMessage(metadata.artwork ? "已解析歌曲信息和内嵌封面，可继续修改。" : "音频已上传，可继续修改歌曲信息。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传音频失败"); }
    finally { setBusy(false); }
  };

  const handleCoverFile = async (file: File) => {
    setBusy(true);
    try {
      const cover = await uploadDirect(file, token(), "image");
      setDraft((current) => ({ ...current, cover }));
      setEmbeddedCover(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传封面失败"); }
    finally { setBusy(false); }
  };

  const handleLyricFile = async (file: File) => {
    setBusy(true); setMessage("正在上传歌词…");
    try {
      if (file.size > 1024 * 1024) throw new Error("歌词文件不能超过 1MB");
      const lrc = await file.text();
      const lyricMedia = await uploadDirect(file, token(), "lyric");
      setDraft((current) => ({ ...current, lyricMedia, lrc }));
      setMessage("歌词已上传到 S3 并加入媒体库。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传歌词失败"); }
    finally { setBusy(false); }
  };

  const chooseLyric = async (item: PickerMediaItem) => {
    setBusy(true);
    try {
      const response = await apiFetch(`/media/${item.id}/text`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "读取歌词失败");
      setDraft((current) => ({ ...current, lyricMedia: item, lrc: data.text || "" }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "读取歌词失败"); }
    finally { setBusy(false); setPicker(null); }
  };

  const save = async () => {
    if (!draft.audio) { setMessage("请先上传或选择 S3 音频文件"); return; }
    setBusy(true); setMessage("");
    try {
      let cover = draft.cover;
      if (!cover && embeddedCover) {
        try { cover = await uploadDirect(embeddedCover, token(), "image"); }
        catch { setMessage("内嵌封面上传失败，歌曲将暂时使用无封面状态。"); }
      }
      const response = await apiFetch(track ? `/music/admin/tracks/${track.id}` : "/music/admin/tracks", {
        method: track ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioMediaId: draft.audio.id,
          coverMediaId: cover?.id || null,
          lyricMediaId: draft.lyricMedia?.id || null,
          title: draft.title,
          artist: draft.artist,
          lrc: draft.lrc,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || (track ? "保存歌曲失败" : "添加歌曲失败"));
      onSaved(data);
      if (!track) {
        setDraft({ audio: null, cover: null, lyricMedia: null, title: "", artist: "", lrc: "" });
        setEmbeddedCover(null);
      }
      setMessage(track ? "歌曲已保存" : "歌曲已加入歌单");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存歌曲失败"); }
    finally { setBusy(false); }
  };

  return <div className="space-y-4">
    {message && <p className="rounded-lg bg-adm-input px-3 py-2 text-sm text-adm-text-secondary">{message}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="rounded-lg border border-dashed border-adm-border p-3 text-sm text-adm-text-secondary"><span className="mb-2 flex items-center gap-2"><Upload className="h-4 w-4" />上传音频并自动解析</span><input type="file" accept={AUDIO_FILE_ACCEPT} disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleAudioFile(file); event.currentTarget.value = ""; }} /></label>
      <button type="button" onClick={() => setPicker("audio")} className="rounded-lg border border-adm-border p-3 text-left text-sm text-adm-text-secondary"><Library className="mr-2 inline h-4 w-4" />从 S3 媒体库选择音频</button>
    </div>
    {draft.audio && <p className="truncate text-xs text-adm-text-tertiary">当前音频：{draft.audio.filename}</p>}
    <div className="grid gap-3 sm:grid-cols-2"><input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="歌曲名称" className="rounded-lg border border-adm-border bg-adm-input px-3 py-2 text-sm text-adm-text" /><input value={draft.artist} onChange={(event) => setDraft((current) => ({ ...current, artist: event.target.value }))} placeholder="歌手（可选）" className="rounded-lg border border-adm-border bg-adm-input px-3 py-2 text-sm text-adm-text" /></div>
    <div className="flex flex-wrap gap-2">
      <label className="cursor-pointer rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary"><ImageIcon className="mr-1.5 inline h-4 w-4" />上传封面<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleCoverFile(file); event.currentTarget.value = ""; }} /></label>
      <button type="button" onClick={() => setPicker("cover")} className="rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary">从媒体库选择封面</button>
      {(draft.cover || embeddedCover) && <button type="button" onClick={() => { setDraft((current) => ({ ...current, cover: null })); setEmbeddedCover(null); }} className="rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary"><X className="mr-1 inline h-3.5 w-3.5" />清除封面</button>}
    </div>
    <div className="flex flex-wrap gap-2"><label className="cursor-pointer rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary"><Upload className="mr-1.5 inline h-4 w-4" />上传 LRC 到 S3<input type="file" accept={LYRIC_FILE_ACCEPT} className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleLyricFile(file); event.currentTarget.value = ""; }} /></label><button type="button" onClick={() => setPicker("lyric")} className="rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary">从歌词资源库选择</button>{draft.lyricMedia && <button type="button" onClick={() => setDraft((current) => ({ ...current, lyricMedia: null }))} className="rounded-lg border border-adm-border px-3 py-2 text-sm text-adm-text-secondary">解除歌词文件关联</button>}</div>
    {draft.lyricMedia && <p className="truncate text-xs text-adm-text-tertiary">歌词资源：{draft.lyricMedia.filename}</p>}
    <LyricEditor audioUrl={draft.audio?.url || ""} value={draft.lrc} onChange={(lrc) => setDraft((current) => ({ ...current, lrc }))} />
    <div className="flex gap-2"><button type="button" onClick={() => void save()} disabled={busy || !draft.audio} className="rounded-lg bg-adm-primary px-4 py-2 text-sm font-medium text-adm-primary-text disabled:opacity-50">{busy ? <Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" /> : null}{track ? "保存修改" : "添加到歌单"}</button>{onCancel && <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-adm-border px-4 py-2 text-sm text-adm-text-secondary">取消</button>}</div>
    <MediaPicker open={picker === "audio"} onClose={() => setPicker(null)} category="audio" title="选择 S3 音频" onSelect={(audio) => { setDraft((current) => ({ ...current, audio, title: current.title || audio.filename.replace(/\.[^.]+$/, "") })); setEmbeddedCover(null); }} />
    <MediaPicker open={picker === "cover"} onClose={() => setPicker(null)} category="image" title="选择 S3 封面" onSelect={(cover) => { setDraft((current) => ({ ...current, cover })); setEmbeddedCover(null); }} />
    <MediaPicker open={picker === "lyric"} onClose={() => setPicker(null)} kind="lyric" title="选择 S3 歌词" onSelect={(item) => void chooseLyric(item)} />
  </div>;
}
