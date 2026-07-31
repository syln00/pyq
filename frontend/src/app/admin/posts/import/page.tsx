import type { Metadata } from "next";
import AdminPostImport from "./AdminPostImport";

export const metadata: Metadata = {
  title: "管理后台 - Excel 批量导入动态",
};

export default function Page() {
  return <AdminPostImport />;
}
