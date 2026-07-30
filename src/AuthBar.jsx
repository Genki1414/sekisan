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
        background: "#f5f5f5",
        borderBottom: "1px solid #ddd",
      }}
    >
      {error && (
        <span style={{ color: "crimson", wordBreak: "break-word", flex: "1 1 100%" }}>
          ログインエラー: {error}
        </span>
      )}
      {user ? (
        <>
          <span style={{ wordBreak: "break-word" }}>{user.user_metadata?.name ?? user.email} でログイン中</span>
          <button onClick={signOut} style={{ flex: "0 0 auto" }}>
            ログアウト
          </button>
        </>
      ) : (
        <button onClick={startLineLogin} style={{ flex: "1 1 auto", whiteSpace: "normal", textAlign: "center" }}>
          LINEでログイン（見積書PDF機能を使う場合）
        </button>
      )}
    </div>
  );
}
