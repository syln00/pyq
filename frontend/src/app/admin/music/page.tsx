import type { Metadata } from "next";
import AdminMusic from "./AdminMusic";

export const metadata: Metadata = { title: "管理后台 - S3 音乐歌单" };

export default function Page() {
  return <AdminMusic />;
}
