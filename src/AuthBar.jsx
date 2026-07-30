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
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0 }}>
            {user.user_metadata?.picture ? (
              <img
                src={user.user_metadata.picture}
                alt=""
                style={{ width: 28, height: 28, borderRadius: "50%", flex: "0 0 auto", objectFit: "cover" }}
              />
            ) : (
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  flex: "0 0 auto",
                  background: "#06C755",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {(user.user_metadata?.name ?? user.email ?? "?").slice(0, 1)}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontWeight: 700, wordBreak: "break-word" }}>
                {user.user_metadata?.name ?? user.email}
              </span>
              <span style={{ fontSize: 11, color: "#5B6470", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#06C755", display: "inline-block" }} />
                LINEでログイン中
              </span>
            </div>
          </div>
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
