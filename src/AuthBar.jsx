import { useEffect, useState } from "react";
import { useSession } from "./lib/useSession";
import { startLineLogin, completeLineLoginIfNeeded, signOut } from "./lib/lineAuth";

export default function AuthBar() {
  const session = useSession();
  const [error, setError] = useState(null);

  useEffect(() => {
    completeLineLoginIfNeeded().catch((e) => setError(e.message));
  }, []);

  if (session === undefined) return null;

  const user = session?.user ?? null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        fontSize: 13,
        lineHeight: 1.5,
        background: "#fff",
        borderBottom: "1px solid #D3D8DE",
        color: "#16191D",
      }}
    >
      {error && (
        <span style={{ color: "#BE3A2B", fontWeight: 700, wordBreak: "break-word", flex: "1 1 100%" }}>
          ログインエラー: {error}
        </span>
      )}
      {user ? (
        <>
          <span style={{ wordBreak: "break-word", fontWeight: 600 }}>
            {user.user_metadata?.name ?? user.email} でログイン中
          </span>
          <button
            onClick={signOut}
            style={{ flex: "0 0 auto", padding: "6px 12px", borderRadius: 8, border: "1px solid #D3D8DE", background: "#F1F3F6", color: "#16191D", fontWeight: 700 }}
          >
            ログアウト
          </button>
        </>
      ) : (
        <button
          onClick={startLineLogin}
          style={{ flex: "1 1 auto", whiteSpace: "normal", textAlign: "center", padding: "9px 12px", borderRadius: 8, border: 0, background: "#06C755", color: "#fff", fontWeight: 700 }}
        >
          LINEでログイン（見積書PDF機能を使う場合）
        </button>
      )}
    </div>
  );
}
