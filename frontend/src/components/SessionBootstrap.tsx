"use client";

import { useEffect } from "react";
import { refreshSessionUser } from "@/lib/auth";

export default function SessionBootstrap() {
  useEffect(() => {
    void refreshSessionUser();
  }, []);
  return null;
}
