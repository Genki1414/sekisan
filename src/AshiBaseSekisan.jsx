import React, { useMemo, useState, useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSession } from "./lib/useSession";
import { startLineLogin } from "./lib/lineAuth";
import { fetchCompanySettings, saveCompanySettings } from "./lib/profile";
import { consumePdfCredit, peekPdfStatus } from "./lib/pdfCredits";
import { startCheckout, openBillingPortal } from "./lib/billing";
import { listProjects, saveProject } from "./lib/projects";

/* 足場積算（戸建・くさび式）— 平面割り付け図 + 高さ断面図（コマ・手摺・寸法）+ 全資材 */

const C = {
  bg: "#E7EAEE", panel: "#FFFFFF", ink: "#16191D", sub: "#5B6470", line: "#D3D8DE",
  amber: "#E3A012", amberInk: "#2A1E00", red: "#BE3A2B", steel: "#8A93A0",
  chip: "#F1F3F6", sky: "#E5EDF4", soil: "#CDBBA3", deck: "#EBB44E", dim: "#6B7480",
};
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const KOMA = { A: 450, B: 475 };
const LAYER = { A: 1800, B: 1900 };
const STUB = { A: 240, B: 475 };
const JACK_MAX = 400, JACKBASE_HALF = 70;
const SPAN_PALETTE = [1800, 1200, 900, 600];
const POST_KOMA = [8, 6, 4, 2, 1];
const KOMA_NAME = { A: { 8: "36", 6: "27", 4: "18", 2: "09", 1: "045" }, B: { 8: "38", 6: "285", 4: "19", 2: "095", 1: "0475" } };
const NEGARAMI = { A: "08", B: "1425" };

function composeKoma(total) {
  const n8 = Math.floor(total / 8), rem = total - n8 * 8, list = [];
  for (let i = 0; i < n8; i++) list.push(8);
  if (rem > 0) list.push(POST_KOMA.slice().reverse().find((k) => k >= rem) || 1);
  return list;
}
// 1本の支柱を構成するコマの内訳を「36支柱×2本、09支柱×1本」のように表す
function describeKomaList(list, type) {
  const count = {};
  list.forEach((k) => { const nm = KOMA_NAME[type][k] + "支柱"; count[nm] = (count[nm] || 0) + 1; });
  return Object.entries(count).map(([nm, n]) => `${nm}×${n}本`).join("、");
}
function heightEngine({ nokiten, kiso, roof, type }) {
  const layer = LAYER[type], koma = KOMA[type], stub = STUB[type], roofAdd = roof ? 900 : 0;
  let offset = nokiten % layer, jack = kiso + offset - stub, negarami = false, g = 0;
  while (jack > JACK_MAX && g < 12) { offset -= 450; jack = kiso + offset - stub; g++; }
  if (jack < 0) { negarami = true; jack = kiso + offset; g = 0; while (jack > JACK_MAX && g < 12) { offset -= 450; jack = kiso + offset; g++; } }
  const topGround = kiso + nokiten + roofAdd, lowestKoma = kiso + offset;
  const totalKoma = Math.round((topGround - lowestKoma) / koma) + 1;
  const komaList = composeKoma(totalKoma), usedKoma = komaList.reduce((a, b) => a + b, 0);
  const danCount = Math.max(1, Math.round(nokiten / layer) - 1);
  const innerInt = Math.max(1, Math.round((kiso + nokiten - layer - lowestKoma) / koma));
  const innerKomaList = composeKoma(innerInt + 1);
  return { offset, jack, negarami, totalKoma, usedKoma, komaList, innerKomaList, danCount, spare: usedKoma - totalKoma, lowestKoma, topGround };
}
const ADJ_PIECES = { A: [400, 300, 200], B: [350, 150] };
// [floorV, ceilV]内でtargetに近い割り付け。調整材（小片）を最小化し標準スパン(1200/900/600)を優先
function searchLayout(target, type, floorV, ceilV) {
  const adj = ADJ_PIECES[type] || [];
  const adjOpts = [[]]; adj.forEach((x) => adjOpts.push([x])); adj.forEach((x) => adj.forEach((y) => adjOpts.push([x, y])));
  const cap = ceilV === Infinity ? target + 1200 : ceilV;
  const maxA = Math.max(0, Math.ceil(cap / 1800)) + 1;
  let best = null;
  for (let a = 0; a <= maxA; a++)
    for (let b = 0; b <= 2; b++)
      for (let c = 0; c <= 2; c++)
        for (let e = 0; e <= 2; e++) {
          const base = a * 1800 + b * 1200 + c * 900 + e * 600;
          if (base > cap) continue;
          adjOpts.forEach((ao) => {
            const pieces = a + b + c + e + ao.length; if (!pieces) return;
            const sVal = base + ao.reduce((x, y) => x + y, 0);
            if (sVal < floorV || sVal > ceilV) return;
            const nAdj = ao.length, d = Math.abs(sVal - target);
            const better = !best || nAdj < best.nAdj ||
              (nAdj === best.nAdj && (d < best.d ||
              (d === best.d && (a > best.a || (a === best.a && pieces < best.pieces)))));
            if (better) best = { nAdj, d, a, pieces, spans: [...Array(a).fill(1800), ...Array(b).fill(1200), ...Array(c).fill(900), ...Array(e).fill(600), ...ao] };
          });
        }
  return best;
}
function layoutLength(target, type, floorV = 0, ceilV = Infinity) {
  // 敷地幅の頭打ちで下限=上限(ぴったりこの値限定)になるケースで、
  // 標準スパン+調整材の組合せでは1mm単位のその値を作れないことがある。
  // その場合に割付ゼロで諦めず、制約を外してtargetに最も近い組合せへフォールバックする。
  const best = searchLayout(target, type, floorV, ceilV) || searchLayout(target, type, 0, Infinity);
  return best ? best.spans.sort((x, y) => y - x) : [];
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
function splitTsuke(overhang, sL, sR) {
  const capL = sL.shiki - JACKBASE_HALF, capR = sR.shiki - JACKBASE_HALF;
  let l = overhang / 2, r = overhang / 2;
  for (let i = 0; i < 2; i++) { if (l > capL) { r += l - capL; l = capL; } if (r > capR) { l += r - capR; r = capR; } }
  return { l: Math.round(l), r: Math.round(r) };
}
const desiredOverhang = (a, b) => { const d = (s) => Math.min(900, Math.max(s.noki, Math.min(900, s.shiki - JACKBASE_HALF))); return d(a) + d(b); };

// ===== 寸法線ヘルパー =====
function DimH({ x1, x2, y, text, off = 0 }) {
  const yy = y + off;
  return (<g>
    <line x1={x1} y1={yy} x2={x2} y2={yy} stroke={C.dim} strokeWidth="0.8" />
    <line x1={x1} y1={yy - 3} x2={x1} y2={yy + 3} stroke={C.dim} strokeWidth="0.8" />
    <line x1={x2} y1={yy - 3} x2={x2} y2={yy + 3} stroke={C.dim} strokeWidth="0.8" />
    <text x={(x1 + x2) / 2} y={yy - 2} fontSize="8.5" fill={C.dim} textAnchor="middle" fontFamily={mono}>{text}</text>
  </g>);
}
function DimV({ x, y1, y2, text }) {
  return (<g>
    <line x1={x} y1={y1} x2={x} y2={y2} stroke={C.dim} strokeWidth="0.8" />
    <line x1={x - 3} y1={y1} x2={x + 3} y2={y1} stroke={C.dim} strokeWidth="0.8" />
    <line x1={x - 3} y1={y2} x2={x + 3} y2={y2} stroke={C.dim} strokeWidth="0.8" />
    <text x={x - 3} y={(y1 + y2) / 2} fontSize="8.5" fill={C.dim} textAnchor="middle" fontFamily={mono} transform={`rotate(-90 ${x - 3} ${(y1 + y2) / 2})`}>{text}</text>
  </g>);
}

// ===== 高さ断面図 =====
function HeightDiagram({ kiso, nokiten, noki, roof, jack, type, standoff, lowestKoma, rails, hane }) {
  const W = 344, Hh = 344, ground = 294, topPad = 30;
  const total = kiso + nokiten + (roof ? 900 : 0);
  const sc = (ground - topPad) / Math.max(total, 1);
  const y = (h) => ground - h * sc;
  const layer = LAYER[type], koma = KOMA[type], hsc = 0.05;
  const offset = lowestKoma - kiso;
  const wallX = 150;
  const eaveTip = wallX + Math.max(noki, 1) * hsc;
  const scafX = wallX + Math.max(standoff || 200, 200) * hsc;
  const innerX = Math.max(wallX + 20, scafX - 34);
  // 最上段踏板＝軒天高−階高を基準に、そこから階高刻みで下へ配置する（軒天から逆算）
  const platforms = []; for (let h = nokiten - layer; h > 0; h -= layer) platforms.push(kiso + h);
  platforms.sort((a, b) => a - b); // 下から1段目・2段目…と数えられるよう昇順に
  const komaMarks = []; for (let h = lowestKoma; h <= total + 1; h += koma) komaMarks.push(h);
  const railMarks = []; platforms.forEach((p) => { if (rails >= 2) railMarks.push(p + koma); railMarks.push(p + 2 * koma); });
  // 内柱＝最上段踏板までの短い構成（手摺・落下手摺分は立てない）
  const innerTopAbs = kiso + Math.max(0, nokiten - layer);
  const innerKomaMarks = []; for (let h = lowestKoma; h <= innerTopAbs + 1; h += koma) innerKomaMarks.push(h);
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" style={{ background: C.sky, borderRadius: 8 }}>
      <rect x="0" y={ground} width={W} height={Hh - ground} fill={C.soil} />
      <line x1="0" y1={ground} x2={W} y2={ground} stroke="#9c8a70" strokeWidth="1.5" />
      <text x={6} y={ground + 13} fontSize="9" fill="#7a6b55" fontFamily={mono}>地面</text>
      <rect x={wallX - 42} y={y(kiso)} width="42" height={ground - y(kiso)} fill="#B9C0C8" />
      <line x1={wallX} y1={y(kiso)} x2={wallX} y2={y(kiso + nokiten)} stroke="#8a929c" strokeWidth="2" />
      <line x1={wallX - 46} y1={y(kiso)} x2={eaveTip + 4} y2={y(kiso)} stroke={C.dim} strokeDasharray="3 3" strokeWidth="0.8" />
      <text x={6} y={y(kiso) - 2} fontSize="8.5" fill={C.dim} fontFamily={mono}>水切り</text>
      <line x1={wallX - 46} y1={y(kiso + nokiten)} x2={scafX + 30} y2={y(kiso + nokiten)} stroke={C.dim} strokeDasharray="3 3" strokeWidth="0.8" />
      <text x={6} y={y(kiso + nokiten) - 2} fontSize="8.5" fill={C.dim} fontFamily={mono}>軒天</text>
      <line x1={scafX - 14} y1={y(lowestKoma)} x2={scafX + 44} y2={y(lowestKoma)} stroke={C.steel} strokeDasharray="2 2" strokeWidth="0.8" />
      <line x1={wallX} y1={y(kiso + nokiten)} x2={eaveTip} y2={y(kiso + nokiten)} stroke="#7a6b55" strokeWidth="3" />
      <polygon points={`${wallX - 6},${y(kiso + nokiten)} ${(wallX + eaveTip) / 2},${y(kiso + nokiten) - 24} ${eaveTip + 2},${y(kiso + nokiten)}`} fill="#a08b6a" opacity="0.45" />
      <DimH x1={wallX} x2={eaveTip} y={y(kiso + nokiten) - 26} text={`軒出 ${noki}`} />
      {/* 内柱：最上段踏板までの短い構成 */}
      <line x1={innerX} y1={ground - jack * sc} x2={innerX} y2={y(innerTopAbs)} stroke={C.steel} strokeWidth="2" />
      {innerKomaMarks.map((h, i) => (<line key={`ik${i}`} x1={innerX - 4} y1={y(h)} x2={innerX} y2={y(h)} stroke={C.steel} strokeWidth="1" />))}
      <text x={innerX} y={y(innerTopAbs) - 5} fontSize="7.5" fill={C.steel} textAnchor="middle" fontFamily={mono}>内柱</text>
      <rect x={scafX - 3} y={ground - jack * sc} width="6" height={jack * sc} fill={C.steel} />
      <text x={scafX + 8} y={ground - 3} fontSize="8" fill={C.steel} fontFamily={mono}>ｼﾞｬｯｷ{jack}</text>
      <line x1={scafX} y1={ground - jack * sc} x2={scafX} y2={y(total)} stroke={C.ink} strokeWidth="2.5" />
      <text x={scafX} y={y(total) - 20} fontSize="7.5" fill={C.ink} textAnchor="middle" fontFamily={mono}>外柱</text>
      {hane && <text x={scafX + 16} y={y(kiso + nokiten) + 3} fontSize="8" fontWeight="700" fill={C.red} textAnchor="start" fontFamily={mono}>ハネ出し</text>}
      {komaMarks.map((h, i) => (<line key={`k${i}`} x1={scafX - 4} y1={y(h)} x2={scafX} y2={y(h)} stroke={C.ink} strokeWidth="1.2" />))}
      {railMarks.map((h, i) => (<circle key={`r${i}`} cx={scafX + 4} cy={y(h)} r="3.4" fill="#F4C21B" stroke="#9a7b12" strokeWidth="0.6" />))}
      {platforms.map((h, i) => (
        <g key={`p${i}`}>
          <line x1={scafX - 16} y1={y(h)} x2={scafX} y2={y(h)} stroke={C.deck} strokeWidth="4" />
          <text x={scafX + 16} y={y(h) + 3} fontSize="7.5" fill={C.sub} textAnchor="start" fontFamily={mono}>{i + 1}段目</text>
        </g>
      ))}
      {roof && <><circle cx={scafX + 4} cy={y(total)} r="3.4" fill="#F4C21B" stroke="#9a7b12" strokeWidth="0.6" />
        <circle cx={scafX + 4} cy={y(kiso + nokiten + 450)} r="3.4" fill="#F4C21B" stroke="#9a7b12" strokeWidth="0.6" />
        <text x={scafX + 16} y={y(total) + 3} fontSize="8" fill={C.sub} fontFamily={mono}>落下手摺</text></>}
      <DimV x={wallX - 50} y1={ground} y2={y(kiso)} text={`基礎 ${kiso}`} />
      <DimV x={wallX - 50} y1={y(kiso)} y2={y(kiso + nokiten)} text={`軒天 ${nokiten}`} />
      <DimH x1={wallX} x2={scafX} y={ground - 12} text={`離れ ${standoff}`} />
      <DimV x={W - 12} y1={ground} y2={y(total)} text={`足場高 ${total}`} />
      <text x={scafX + 46} y={y(lowestKoma) + 3} fontSize="8" fill={C.steel} fontFamily={mono}>水切りつら{offset >= 0 ? "+" : ""}{offset}</text>
    </svg>
  );
}

// ===== 平面 割り付け図（4面まとめ）=====
function PlanDiagram({ bw, bh, tsuke, spansEW, spansNS, built, hane = {} }) {
  const W = 344, H = 320, m = 40, GAP = 30;
  const gN = built.北 ? GAP : 4, gS = built.南 ? GAP : 4, gE = built.東 ? GAP : 4, gW = built.西 ? GAP : 4;
  const availW = W - 2 * m - (gW + gE), availH = H - 2 * m - (gN + gS);
  const sc = Math.min(availW / Math.max(bw, 1), availH / Math.max(bh, 1));
  const bW = bw * sc, bH = bh * sc;
  const sx = (W - (bW + gW + gE)) / 2, sy = (H - (bH + gN + gS)) / 2;
  const bx = sx + gW, by = sy + gN, sW = bW + gW + gE, sH = bH + gN + gS;
  const cum = (spans) => { let c = 0; const arr = spans.map((v) => { c += v; return c; }); return { arr, tot: Math.max(c, 1) }; };
  const nT = cum(spansEW), eT = cum(spansNS);
  const bTop = nT.arr.map((v) => sx + (v / nT.tot) * sW);
  const bSide = eT.arr.map((v) => sy + (v / eT.tot) * sH);
  const midTop = spansEW.map((v, i) => ({ x: sx + (((i === 0 ? 0 : nT.arr[i - 1]) + v / 2) / nT.tot) * sW, s: v }));
  const midSide = spansNS.map((v, i) => ({ y: sy + (((i === 0 ? 0 : eT.arr[i - 1]) + v / 2) / eT.tot) * sH, s: v }));
  const allTopX = [sx, ...bTop], allSideY = [sy, ...bSide];
  const innerTopX = allTopX.filter((_, i) => i % 2 === 0 && i > 0 && i < allTopX.length - 1), innerSideY = allSideY.filter((_, i) => i % 2 === 0 && i > 0 && i < allSideY.length - 1);
  const edge = (b) => (b ? C.amber : "#cfd4da"), dash = (b) => (b ? "" : "4 3"), lbl = (b) => (b ? C.ink : "#b4bac2");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ background: "#fff", borderRadius: 8, border: `1px solid ${C.line}` }}>
      <line x1={sx} y1={sy} x2={sx + sW} y2={sy} stroke={edge(built.北)} strokeWidth="2" strokeDasharray={dash(built.北)} />
      <line x1={sx} y1={sy + sH} x2={sx + sW} y2={sy + sH} stroke={edge(built.南)} strokeWidth="2" strokeDasharray={dash(built.南)} />
      <line x1={sx} y1={sy} x2={sx} y2={sy + sH} stroke={edge(built.西)} strokeWidth="2" strokeDasharray={dash(built.西)} />
      <line x1={sx + sW} y1={sy} x2={sx + sW} y2={sy + sH} stroke={edge(built.東)} strokeWidth="2" strokeDasharray={dash(built.東)} />
      <rect x={bx} y={by} width={bW} height={bH} fill="#E3E7EC" stroke="#8a929c" strokeWidth="1.2" />
      <text x={bx + bW / 2} y={by + bH - 8} fontSize="9" fill={C.sub} textAnchor="middle" fontFamily={mono}>建物</text>
      {built.北 && allTopX.map((px, i) => (<line key={`tn${i}`} x1={px} y1={sy - 4} x2={px} y2={sy + 4} stroke={C.ink} strokeWidth="1.2" />))}
      {built.南 && allTopX.map((px, i) => (<line key={`ts${i}`} x1={px} y1={sy + sH - 4} x2={px} y2={sy + sH + 4} stroke={C.ink} strokeWidth="1.2" />))}
      {built.西 && allSideY.map((py, i) => (<line key={`lw${i}`} x1={sx - 4} y1={py} x2={sx + 4} y2={py} stroke={C.ink} strokeWidth="1.2" />))}
      {built.東 && allSideY.map((py, i) => (<line key={`re${i}`} x1={sx + sW - 4} y1={py} x2={sx + sW + 4} y2={py} stroke={C.ink} strokeWidth="1.2" />))}
      {built.北 && innerTopX.map((px, i) => (<circle key={`inn${i}`} cx={px} cy={sy + 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />))}
      {built.南 && innerTopX.map((px, i) => (<circle key={`ins${i}`} cx={px} cy={sy + sH - 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />))}
      {built.西 && innerSideY.map((py, i) => (<circle key={`inw${i}`} cx={sx + 9} cy={py} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />))}
      {built.東 && innerSideY.map((py, i) => (<circle key={`ine${i}`} cx={sx + sW - 9} cy={py} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />))}
      {built.北 && !built.西 && <circle cx={sx} cy={sy + 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.西 && !built.北 && <circle cx={sx + 9} cy={sy} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.北 && !built.東 && <circle cx={sx + sW} cy={sy + 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.東 && !built.北 && <circle cx={sx + sW - 9} cy={sy} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.南 && !built.東 && <circle cx={sx + sW} cy={sy + sH - 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.東 && !built.南 && <circle cx={sx + sW - 9} cy={sy + sH} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.南 && !built.西 && <circle cx={sx} cy={sy + sH - 9} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {built.西 && !built.南 && <circle cx={sx + 9} cy={sy + sH} r="2.2" fill="#fff" stroke={C.steel} strokeWidth="1.2" />}
      {(built.北 || built.南) && midTop.map((mm, i) => (<text key={`mt${i}`} x={mm.x} y={sy - 7} fontSize="7.5" fill={C.sub} textAnchor="middle" fontFamily={mono}>{mm.s}</text>))}
      {(built.西 || built.東) && midSide.map((mm, i) => (<text key={`ms${i}`} x={sx - 7} y={mm.y + 2} fontSize="7.5" fill={C.sub} textAnchor="middle" fontFamily={mono} transform={`rotate(-90 ${sx - 7} ${mm.y + 2})`}>{mm.s}</text>))}
      <text x={sx + sW / 2} y={13} fontSize="11" fontWeight="700" fill={lbl(built.北)} textAnchor="middle">北</text>
      <text x={sx + sW / 2} y={H - 5} fontSize="11" fontWeight="700" fill={lbl(built.南)} textAnchor="middle">南</text>
      <text x={W - 11} y={sy + sH / 2} fontSize="11" fontWeight="700" fill={lbl(built.東)} textAnchor="middle">東</text>
      <text x={11} y={sy + sH / 2} fontSize="11" fontWeight="700" fill={lbl(built.西)} textAnchor="middle">西</text>
      <DimH x1={bx} x2={bx + bW} y={by + 14} text={`${bw}`} />
      <DimV x={bx + 14} y1={by} y2={by + bH} text={`${bh}`} />
      {built.北 && <DimV x={bx + bW / 2} y1={sy} y2={by} text={`${tsuke.北}`} />}
      {built.南 && <DimV x={bx + bW / 2} y1={by + bH} y2={sy + sH} text={`${tsuke.南}`} />}
      {built.東 && <DimH x1={bx + bW} x2={sx + sW} y={by + bH / 2} text={`${tsuke.東}`} />}
      {built.西 && <DimH x1={sx} x2={bx} y={by + bH / 2} text={`${tsuke.西}`} />}
      {/* 足場の外郭線の外側に表示。北=上端の帯にあるスパン長さ表示、西=左端のスパン長さ表示と
          重ならないよう、それぞれ十分な間隔を空ける */}
      {built.北 && hane.北 && <text x={bx + bW / 2} y={sy - 20} fontSize="8" fontWeight="700" fill={C.red} textAnchor="middle">ハネ出し</text>}
      {built.南 && hane.南 && <text x={bx + bW / 2} y={sy + sH + 16} fontSize="8" fontWeight="700" fill={C.red} textAnchor="middle">ハネ出し</text>}
      {built.東 && hane.東 && <text x={sx + sW + 16} y={by + bH / 2 - 8} fontSize="8" fontWeight="700" fill={C.red} textAnchor="middle" transform={`rotate(-90 ${sx + sW + 16} ${by + bH / 2 - 8})`}>ハネ出し</text>}
      {built.西 && hane.西 && <text x={sx - 16} y={by + bH / 2 - 8} fontSize="8" fontWeight="700" fill={C.red} textAnchor="middle" transform={`rotate(-90 ${sx - 16} ${by + bH / 2 - 8})`}>ハネ出し</text>}
    </svg>
  );
}

// ===== UI 部品 =====
function Field({ label, val, set, unit = "mm" }) {
  return (<label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 0" }}>
    <span style={{ fontSize: 11, color: C.sub }}>{label}</span>
    <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.line}`, borderRadius: 8, background: "#fff" }}>
      <input value={val} onChange={(e) => set(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric"
        style={{ width: "100%", border: 0, outline: "none", padding: "9px 10px", fontFamily: mono, fontSize: 15, color: C.ink, minWidth: 0, background: "transparent" }} />
      <span style={{ fontSize: 11, color: C.sub, padding: "0 8px" }}>{unit}</span>
    </div></label>);
}
function TextField({ label, val, set, ph }) {
  return (<label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 0", minWidth: 0 }}>
    <span style={{ fontSize: 11, color: C.sub }}>{label}</span>
    <input value={val} placeholder={ph || ""} onChange={(e) => set(e.target.value)}
      style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 10px", fontSize: 14, color: C.ink, background: "#fff", outline: "none", minWidth: 0 }} />
  </label>);
}
function Section({ title, children }) {
  return (<div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.4, marginBottom: 10 }}>{title}</div>{children}</div>);
}
function ResultCard({ title, children, hero, note }) {
  return (<div style={{ background: C.panel, border: `1px solid ${hero ? C.amber : C.line}`, borderRadius: 12, padding: 12, marginBottom: 12, boxShadow: hero ? `0 0 0 3px ${C.amber}22` : "none" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>{note && <div style={{ fontSize: 10, color: C.red }}>{note}</div>}</div>{children}</div>);
}
function Row({ k, v, warn }) {
  return (<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0" }}>
    <span style={{ fontSize: 12, color: C.sub }}>{k}</span>
    <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: warn ? C.red : C.ink }}>{v}</span></div>);
}

function QRow({ k, v, red }) {
  return (<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "3px 0" }}>
    <span style={{ fontSize: 12, color: C.sub }}>{k}</span>
    <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: red ? C.red : C.ink }}>¥{v.toLocaleString()}</span>
  </div>);
}
const FACE_KEYS = ["北", "東", "南", "西"];
const PERFACE_ROWS = ["踏板", "手摺(各段)", "根がらみ", "落下手摺", "大ブラ", "ブレス", "メッシュ"];

export default function AshiBaseSekisan() {
  const session = useSession();
  const user = session?.user ?? null;
  const [type, setType] = useState("A");
  const [nokiten, setNokiten] = useState("5400");
  const [kiso, setKiso] = useState("400");
  const [roof, setRoof] = useState(true);
  const [rails, setRails] = useState(1);
  const [stairs, setStairs] = useState(true);
  const [faceOpen, setFaceOpen] = useState(false);
  const [matOpen, setMatOpen] = useState(true);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState([]);
  const [saveMsg, setSaveMsg] = useState("");
  const [heightDir, setHeightDir] = useState("北");
  const [quote, setQuote] = useState({ atesaki: "", genba: "", tanka: "" });
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState({ jisha: "", jusho: "", tel: "", tanto: "" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdfStatus, setPdfStatus] = useState({ remainingFree: 3, plan: "none" });
  const [pdfView, setPdfView] = useState(false);
  const [msg, setMsg] = useState("");
  const [discount, setDiscount] = useState({ amount: "", unit: 0 });
  useEffect(() => {
    if (!user) { setSettings({ jisha: "", jusho: "", tel: "", tanto: "" }); setSavedProjects([]); return; }
    (async () => {
      try { setSettings(await fetchCompanySettings()); } catch (e) {}
      try { setPdfStatus(await peekPdfStatus()); } catch (e) {}
      try { setSavedProjects(await listProjects()); } catch (e) {}
    })();
  }, [user]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState({}, "", url.toString());
    if (checkout === "success") {
      setMsg("ご契約ありがとうございます。反映まで少し時間がかかる場合があります。");
      if (user) peekPdfStatus().then(setPdfStatus).catch(() => {});
    }
  }, [user]);
  const [faces, setFaces] = useState({
    北: { len: "9000", noki: "700", shiki: "1000" }, 東: { len: "7000", noki: "700", shiki: "1200" },
    南: { len: "9000", noki: "500", shiki: "900" }, 西: { len: "7000", noki: "300", shiki: "870" },
  });

  const R = useMemo(() => {
    const n = (x) => parseInt(x || "0", 10) || 0;
    const F = Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, { noki: n(v.noki), shiki: n(v.shiki) }]));
    const L = { 北: n(faces.北.len), 東: n(faces.東.len), 南: n(faces.南.len), 西: n(faces.西.len) };
    const built = { 北: L.北 > 0, 東: L.東 > 0, 南: L.南 > 0, 西: L.西 > 0 };
    const ewLen = L.北 || L.南, nsLen = L.東 || L.西;
    const H = heightEngine({ nokiten: n(nokiten), kiso: n(kiso), roof, type });

    const capOf = (sd) => sd.shiki - JACKBASE_HALF;
    const idealOh = (sd) => {
      const cap = capOf(sd); let want = sd.noki + 100;
      if (want <= 600 && cap > 600) want = Math.min(want + 300, cap, 900); // 600幅を優先して伸ばす
      return Math.max(0, Math.min(want, cap));
    };
    const minOh = (sd) => Math.max(0, Math.min(sd.noki, capOf(sd)));          // 軒をかわす下限
    // 離れ配分：両側組立なら折半＋敷地キャップ。片側のみ組立なら開放側はオーバーハング0（建物端まで）
    const axisSplit = (len, sL, sR, bL, bR) => {
      if (len <= 0 || (!bL && !bR)) return { l: 0, r: 0, sc: len > 0 ? layoutLength(len, type) : [] };
      const tgt = (bL ? idealOh(sL) : 0) + (bR ? idealOh(sR) : 0); // 目標オーバーハング（軒出+100の合計）
      const flr = (bL ? minOh(sL) : 0) + (bR ? minOh(sR) : 0);     // 下限（軒をかわす）
      const cei = (bL ? capOf(sL) : 0) + (bR ? capOf(sR) : 0);     // 上限（敷地−70）
      const sc = layoutLength(len + tgt, type, len + flr, len + cei);
      const actual = Math.max(0, sum(sc) - len);
      if (bL && bR) {
        const iL = idealOh(sL), iR = idealOh(sR), it = iL + iR || 1;
        let l = Math.min(Math.round(actual * iL / it), capOf(sL));
        let r = Math.min(actual - l, capOf(sR));
        return { l, r, sc };
      }
      return bL ? { l: actual, r: 0, sc } : { l: 0, r: actual, sc };
    };
    const EWs = axisSplit(ewLen, F.西, F.東, built.西, built.東);
    const NSs = axisSplit(nsLen, F.北, F.南, built.北, built.南);
    const scEW = EWs.sc, scNS = NSs.sc;
    const tsuke = { 北: NSs.l, 南: NSs.r, 東: EWs.r, 西: EWs.l };
    const flag = (s, st) => ({ hane: s.noki > st, over: st > s.shiki - JACKBASE_HALF });
    const spansOf = (k) => ((k === "北" || k === "南") ? scEW : scNS);
    const builtFaces = FACE_KEYS.filter((k) => built[k]);
    const faceRows = builtFaces.map((k) => ({ name: k, len: sum(spansOf(k)), spans: spansOf(k), standoff: tsuke[k], f: flag(F[k], tsuke[k]) }));

    const D = H.danCount;
    const innerOf = (S) => Math.max(0, Math.floor((S - 1) / 2));
    const faceSpans = {}; FACE_KEYS.forEach((k) => (faceSpans[k] = built[k] ? spansOf(k).length : 0));
    const totSpans = builtFaces.reduce((a, k) => a + faceSpans[k], 0);
    const CYC = [["北", "東"], ["東", "南"], ["南", "西"], ["西", "北"]];
    const corners = CYC.filter(([a, b]) => built[a] && built[b]).length;
    const outerPosts = Math.max(0, totSpans + builtFaces.length - corners);
    const openEnds = CYC.filter(([a, b]) => built[a] !== built[b]).length; // 片側のみ組立の角＝開放端
    const innerLines = builtFaces.reduce((a, k) => a + innerOf(faceSpans[k]), 0) + openEnds;
    const kaidan = (stairs && totSpans > 0) ? (D + (roof ? 1 : 0)) : 0;

    // スパン長の分布（組立面のみ）
    const allSpans = builtFaces.flatMap((k) => spansOf(k));
    const spanCount = {}; allSpans.forEach((Lx) => (spanCount[Lx] = (spanCount[Lx] || 0) + 1));
    const codeOf = (Lx) => ({ 1800: "18", 1500: "15", 1200: "12", 900: "09", 600: "06", 400: "04", 350: "035", 300: "03", 200: "02", 150: "015" }[Lx] || String(Lx));

    const bySize = {};
    const add = (list, cnt) => list.forEach((k) => { const nm = KOMA_NAME[type][k] + "支柱"; bySize[nm] = (bySize[nm] || 0) + cnt; });
    add(H.komaList, outerPosts); add(H.innerKomaList, innerLines);

    const fwOf = (rebar) => (rebar > 0 && rebar <= 700) ? 400 : 600; // 離れ→足場幅（≦700で400幅）
    const perSpanTesuri = 1 + D * rails + (roof ? 2 : 0);
    const ita = {}, tesuri = {}, mesh = {};
    builtFaces.forEach((k) => {
      const spans = spansOf(k), fw = fwOf(tsuke[k]), pfx = fw === 600 ? "40" : "25";
      spans.forEach((Lx) => {
        const c = codeOf(Lx);
        if (Lx === 600) tesuri["06手摺"] = (tesuri["06手摺"] || 0) + D;  // 600スパンは4006踏板でなく踏板用600手摺
        else ita[pfx + c] = (ita[pfx + c] || 0) + D;                    // 踏板：足場幅で25xx/40xx
        tesuri[c + "手摺"] = (tesuri[c + "手摺"] || 0) + perSpanTesuri;   // 外周手摺は長さ別
        const w = (Lx / 1000).toFixed(1).replace(/\.0$/, "");
        mesh[`${w}×6.3m`] = (mesh[`${w}×6.3m`] || 0) + 1;
      });
      const conn = fw === 600 ? "06手摺" : "04手摺";
      tesuri[conn] = (tesuri[conn] || 0) + innerOf(spans.length) * (1 + D); // 内柱連結（足場幅ぶん）
    });
    if (openEnds > 0) tesuri["06手摺"] = (tesuri["06手摺"] || 0) + openEnds * (1 + D);
    // 大/小ブラ＝外柱-only（外柱本数−内部内柱、ユニーク）。fw比で配分
    const outerOnly = Math.max(0, outerPosts - innerLines); // 外柱-only＝外柱−全内柱（内部＋開放端）
    const faceOO = builtFaces.map((k) => ({ oo: Math.max(0, (faceSpans[k] + 1) - innerOf(faceSpans[k])), fw: fwOf(tsuke[k]) }));
    const ooSum = faceOO.reduce((a, f) => a + f.oo, 0) || 1;
    let o6 = 0, o4 = 0;
    faceOO.forEach((f) => { const v = outerOnly * f.oo / ooSum; if (f.fw === 600) o6 += v; else o4 += v; });
    const ohBra = Math.round(o6) * D, koBra = Math.round(o4) * D;

    if (stairs && totSpans > 0) {
      add(H.komaList, 3);
      const stairP2 = KOMA_NAME[type][2] + "支柱"; bySize[stairP2] = (bySize[stairP2] || 0) + 3;
      tesuri["18手摺"] = (tesuri["18手摺"] || 0) + 11;
      tesuri["12手摺"] = (tesuri["12手摺"] || 0) + 3;
      tesuri["06手摺"] = (tesuri["06手摺"] || 0) + 19;
      ita["4018"] = (ita["4018"] || 0) + 1;
    }

    const sujiFace = (S) => (S < 6 ? 3 : 3 + (S - 5));
    const sujiTotal = builtFaces.reduce((a, k) => a + sujiFace(faceSpans[k]), 0) + kaidan;

    const materials = [
      ...Object.entries(bySize).map(([name, qty]) => ({ name, qty, grp: "支柱" })),
      ...(H.negarami ? [{ name: `根がらみ支柱(${NEGARAMI[type]})`, qty: outerPosts + innerLines, grp: "支柱" }] : []),
      ...Object.entries(ita).map(([name, qty]) => ({ name, qty, grp: "踏板" })),
      ...Object.entries(tesuri).map(([name, qty]) => ({ name, qty, grp: "手摺(根がらみ+各段+落下)" })),
      { name: "大ブラ", qty: ohBra, grp: "ブラケット" },
      ...(koBra > 0 ? [{ name: "小ブラ", qty: koBra, grp: "ブラケット" }] : []),
      ...(stairs ? [{ name: "大ハネ", qty: 3, grp: "ブラケット" }] : []),
      { name: "18ブレス", qty: sujiTotal, grp: "ブレス" },
      { name: "固定ジャッキ", qty: outerPosts + innerLines + (stairs && totSpans > 0 ? 3 : 0), grp: "ジャッキ" },
      { name: "壁当ジャッキ", qty: innerLines, grp: "ジャッキ" },
      { name: "壁当ホルダー", qty: innerLines, grp: "ジャッキ" },
      ...Object.entries(mesh).map(([name, qty]) => ({ name, qty, grp: "メッシュ" })),
      { name: "アラオ製ウルトラワイドベース", qty: outerPosts + innerLines + (stairs && totSpans > 0 ? 3 : 0), grp: "下部" },
      { name: "4mパイプ(火打)", qty: corners, grp: "補強" },
      { name: "自在クランプ(火打)", qty: corners * 2, grp: "補強" },
      ...(faceRows.some((r) => r.f.hane) ? [
        { name: "大ピン(ハネ出し)", qty: 0, grp: "ハネ出し" },
        { name: "小ピン(ハネ出し)", qty: 0, grp: "ハネ出し" },
        { name: "02ピン(ハネ出し)", qty: 0, grp: "ハネ出し" },
      ] : []),
      { name: "昇降階段", qty: kaidan, grp: "昇降" },
    ];

    const faceMat = {};
    FACE_KEYS.forEach((k) => { const S = faceSpans[k] || 0; faceMat[k] = {
      "踏板": S * D, "手摺(各段)": S * D * rails, "根がらみ": S, "落下手摺": roof ? S * 2 : 0,
      "大ブラ": (S + 1) * D, "ブレス": sujiFace(S), "メッシュ": S }; });
    const faceTot = {}; PERFACE_ROWS.forEach((r) => faceTot[r] = FACE_KEYS.reduce((a, k) => a + faceMat[k][r], 0));
    const perimeter = builtFaces.reduce((a, k) => a + sum(spansOf(k)), 0);
    const nobeArea = Math.round((perimeter * H.topGround) / 1e6 * 10) / 10; // 組立面の外周×足場高 ㎡
    const hane = Object.fromEntries(faceRows.map((r) => [r.name, r.f.hane]));
    return { H, faceRows, materials, faceMat, faceTot, tsuke, scEW, scNS, ewLen, nsLen, built, nobeArea, hane };
  }, [type, nokiten, kiso, roof, rails, stairs, faces]);

  const H = R.H;
  const grps = [...new Set(R.materials.map((m) => m.grp))];
  const tankaN = parseInt(quote.tanka) || 0;
  const kingaku = Math.round((R.nobeArea || 0) * tankaN);
  const extraLines = items.map((it) => ({ name: it.name || "（項目）", qtyText: `${it.qty || 0}${it.unit || ""}`, amount: (parseInt(it.qty) || 0) * (parseInt(it.price) || 0) }));
  const allLines = [{ name: "足場工事一式", qtyText: `${R.nobeArea} ㎡`, amount: kingaku }, ...extraLines];
  const grandTotal = allLines.reduce((a, l) => a + l.amount, 0);
  const nebikiInput = parseInt(discount.amount) || 0;
  const afterManual = Math.max(0, grandTotal - nebikiInput);
  const total0 = afterManual + Math.round(afterManual * 0.1);
  const sougaku = discount.unit > 0 ? Math.floor(total0 / discount.unit) * discount.unit : total0;
  const zeinuki = Math.round(sougaku / 1.1);
  const zei = sougaku - zeinuki;
  const nebikiTotal = Math.max(0, grandTotal - zeinuki);
  const today = new Date().toLocaleDateString("ja-JP");
  const saveSettings = async (ns) => {
    setSettings(ns);
    if (!user) { setMsg("設定の保存にはLINEログインが必要です"); return; }
    try { await saveCompanySettings(ns); } catch (e) { setMsg("設定の保存に失敗しました"); }
  };
  const handleSaveProject = async () => {
    if (!user) { setMsg("保存にはLINEログインが必要です"); startLineLogin(); return; }
    try {
      await saveProject({
        clientName: quote.atesaki,
        siteName: quote.genba,
        input: { type, nokiten, kiso, roof, rails, stairs, faces },
      });
      setSavedProjects(await listProjects());
      setMsg("保存しました");
    } catch (e) {
      setMsg("保存に失敗しました");
    }
  };
  const handleLoadProject = (p) => {
    const inp = p.input || {};
    if (inp.type) setType(inp.type);
    if (inp.nokiten != null) setNokiten(inp.nokiten);
    if (inp.kiso != null) setKiso(inp.kiso);
    if (inp.roof != null) setRoof(inp.roof);
    if (inp.rails != null) setRails(inp.rails);
    if (inp.stairs != null) setStairs(inp.stairs);
    if (inp.faces) setFaces(inp.faces);
    setMsg(`「${p.client_name || "元請未設定"} / ${p.site_name || "現場未設定"}」を読み込みました`);
  };
  const addItem = () => setItems([...items, { name: "", qty: "", unit: "", price: "" }]);
  const setItem = (i, k, v) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const delItem = (i) => setItems(items.filter((_, j) => j !== i));
  const makeQuote = async () => {
    if (!tankaN) { setMsg("足場の単価を入力してください"); return; }
    if (!user) { setMsg("見積書PDFの作成にはLINEログインが必要です"); startLineLogin(); return; }
    try {
      const result = await consumePdfCredit();
      if (!result.allowed) {
        setMsg("無料は毎月3回まで。追加のご利用は有料プランで（近日公開）");
        setPdfStatus({ remainingFree: 0, plan: result.plan });
        return;
      }
      setMsg("");
      setPdfStatus({ remainingFree: result.plan === "none" ? result.remaining_free : null, plan: result.plan });
      setPdfView(true);
    } catch (e) {
      setMsg("見積書の作成でエラーが発生しました");
    }
  };
  const buildQuoteImage = () => new Promise((resolve) => {
    const sc = 2, W = 720, H = 1040, cv = document.createElement("canvas");
    cv.width = W * sc; cv.height = H * sc; const x = cv.getContext("2d"); x.scale(sc, sc);
    const ink = "#16191D", sub = "#5B6470", line = "#D3D8DE";
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
    let y = 66; x.fillStyle = ink; x.textAlign = "center"; x.font = "bold 34px sans-serif";
    x.fillText("御　見　積　書", W / 2, y); y += 44; x.textAlign = "left";
    x.font = "20px sans-serif"; x.fillText(`${quote.atesaki || "お客様"} 御中`, 50, y);
    x.strokeStyle = ink; x.lineWidth = 1; x.beginPath(); x.moveTo(50, y + 7); x.lineTo(330, y + 7); x.stroke();
    x.textAlign = "right"; x.fillStyle = sub; x.font = "14px sans-serif"; x.fillText(today, W - 50, y - 16); x.textAlign = "left";
    y += 30; x.fillStyle = sub; x.font = "13px sans-serif"; x.fillText(`現場：${quote.genba || "—"}`, 50, y);
    y += 30; x.fillStyle = ink; x.font = "14px sans-serif"; x.fillText("下記の通り御見積り申し上げます。", 50, y); y += 22;
    const tx = 50, tw = W - 100, cQty = tx + tw - 240, cAmt = tx + tw;
    x.fillStyle = "#f2f4f7"; x.fillRect(tx, y, tw, 32); x.strokeStyle = line; x.strokeRect(tx, y, tw, 32);
    x.fillStyle = ink; x.font = "bold 14px sans-serif"; x.fillText("項目", tx + 8, y + 21);
    x.textAlign = "right"; x.fillText("数量", cQty + 90, y + 21); x.fillText("金額", cAmt - 8, y + 21); x.textAlign = "left"; y += 32;
    allLines.forEach((l) => {
      x.strokeRect(tx, y, tw, 34); x.fillStyle = ink; x.font = "14px sans-serif"; x.fillText(l.name, tx + 8, y + 22);
      x.textAlign = "right"; x.font = "13px monospace"; x.fillText(l.qtyText, cQty + 90, y + 22);
      x.fillText("¥" + l.amount.toLocaleString(), cAmt - 8, y + 22); x.textAlign = "left"; y += 34;
    });
    y += 34; x.textAlign = "right"; x.fillStyle = ink; x.font = "bold 22px sans-serif";
    x.font = "14px sans-serif"; x.fillStyle = sub;
    x.fillText(`税抜価格　¥${zeinuki.toLocaleString()}`, W - 50, y); y += 22;
    x.fillText(`消費税(10%)　¥${zei.toLocaleString()}`, W - 50, y); y += 28;
    x.fillStyle = ink; x.font = "bold 22px sans-serif"; x.fillText(`総額 ¥${sougaku.toLocaleString()}`, W - 50, y); y += 50;
    x.font = "bold 18px sans-serif"; x.fillText(settings.jisha || "（自社名）", W - 50, y); y += 24;
    x.font = "13px sans-serif"; x.fillStyle = sub;
    if (settings.jusho) { x.fillText(settings.jusho, W - 50, y); y += 20; }
    if (settings.tel || settings.tanto) { x.fillText(`${settings.tel}${settings.tanto ? "　担当：" + settings.tanto : ""}`, W - 50, y); y += 20; }
    x.textAlign = "left"; const fy = H - 74; x.strokeStyle = line; x.beginPath(); x.moveTo(50, fy - 14); x.lineTo(W - 50, fy - 14); x.stroke();
    x.fillStyle = ink; x.fillRect(50, fy, 46, 46); x.fillStyle = "#fff"; x.font = "11px sans-serif"; x.textAlign = "center"; x.fillText("QR", 73, fy + 28); x.textAlign = "left";
    x.fillStyle = sub; x.font = "13px sans-serif"; x.fillText("Powered by AshiBase", 108, fy + 18); x.fillText("足場積算・資材管理", 108, fy + 38);
    cv.toBlob((b) => resolve(b), "image/png");
  });
  const downloadQuote = async () => {
    const b = await buildQuoteImage(); const url = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = url; a.download = `御見積_${quote.genba || "足場"}.png`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  const shareQuote = async () => {
    try {
      const b = await buildQuoteImage(); const f = new File([b], "御見積.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: "御見積" }); return; }
    } catch (e) {}
    await downloadQuote();
    setMsg("画像を保存しました。LINEではこの画像を添付して送ってください");
  };

  const buildDiagramsImage = () => new Promise((resolve) => {
    const svgToImage = (svgString) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
    });

    (async () => {
      const heightSvg = renderToStaticMarkup(
        <HeightDiagram
          kiso={parseInt(kiso) || 0} nokiten={parseInt(nokiten) || 0}
          noki={parseInt(faces[heightDir].noki) || 0} roof={roof} jack={H.jack} type={type}
          standoff={R.tsuke[heightDir]} lowestKoma={H.lowestKoma} rails={rails}
          hane={R.faceRows.find((f) => f.name === heightDir)?.f.hane}
        />
      );
      const planSvg = renderToStaticMarkup(
        <PlanDiagram bw={R.ewLen} bh={R.nsLen} tsuke={R.tsuke} spansEW={R.scEW} spansNS={R.scNS} built={R.built} hane={R.hane} />
      );
      const [heightImg, planImg] = await Promise.all([svgToImage(heightSvg), svgToImage(planSvg)]);

      const sc = 2, W = 720, headerH = 90, diagW = 344, diagH1 = 344, diagH2 = 320;
      const matLines = grps.flatMap((g) => [
        { header: g },
        ...R.materials.filter((m) => m.grp === g).map((m) => ({ name: m.name, qty: m.qty })),
      ]);
      const matRowH = 20, matTop = 40;
      const matH = matTop + matLines.length * matRowH + 20;
      const totalH = headerH + diagH1 + 16 + diagH2 + 24 + matH;

      const cv = document.createElement("canvas");
      cv.width = W * sc; cv.height = totalH * sc;
      const x = cv.getContext("2d"); x.scale(sc, sc);
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, totalH);

      x.textAlign = "left"; x.fillStyle = "#16191D"; x.font = "bold 20px sans-serif";
      x.fillText(`${quote.atesaki || "元請未設定"} / ${quote.genba || "現場未設定"}`, 24, 32);
      x.font = "12px sans-serif"; x.fillStyle = "#5B6470";
      x.fillText(new Date().toLocaleDateString("ja-JP"), 24, 52);
      x.fillText(`延べ面積 ${R.nobeArea}㎡（${type}タイプ・${heightDir}面断面）`, 24, 70);

      let y = headerH;
      x.drawImage(heightImg, (W - diagW) / 2, y, diagW, diagH1);
      y += diagH1 + 16;
      x.drawImage(planImg, (W - diagW) / 2, y, diagW, diagH2);
      y += diagH2 + 24;

      x.font = "bold 13px sans-serif"; x.fillStyle = "#16191D";
      x.fillText("資材リスト（概算・要検証）", 24, y);
      y += matTop - 20;
      matLines.forEach((l) => {
        y += matRowH;
        if (l.header) {
          x.font = "bold 11px sans-serif"; x.fillStyle = "#5B6470"; x.textAlign = "left";
          x.fillText(l.header, 24, y);
        } else {
          x.font = "12px sans-serif"; x.fillStyle = "#16191D";
          x.textAlign = "left"; x.fillText(l.name, 40, y);
          x.textAlign = "right"; x.fillText(String(l.qty), W - 24, y);
        }
      });

      cv.toBlob((b) => resolve(b), "image/png");
    })();
  });

  const downloadDiagrams = async () => {
    const b = await buildDiagramsImage(); const url = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = url; a.download = `積算_${quote.genba || "現場"}.png`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  const shareDiagrams = async () => {
    try {
      const b = await buildDiagramsImage(); const f = new File([b], "積算.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: "積算" }); return; }
    } catch (e) {}
    await downloadDiagrams();
    setMsg("画像を保存しました。LINEではこの画像を添付して送ってください");
  };
  const handleShareDiagrams = async () => {
    if (!user) { setMsg("共有にはLINEログインが必要です"); startLineLogin(); return; }
    try {
      const result = await consumePdfCredit();
      if (!result.allowed) {
        setMsg("無料は毎月3回まで（見積書PDFと共通の回数です）。追加のご利用は有料プランで");
        setPdfStatus({ remainingFree: 0, plan: result.plan });
        return;
      }
      setPdfStatus({ remainingFree: result.plan === "none" ? result.remaining_free : null, plan: result.plan });
      await shareDiagrams();
    } catch (e) {
      setMsg("共有画像の作成でエラーが発生しました");
    }
  };

  return (
    <div style={{ minHeight: "100%", background: C.bg, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif", padding: 14 }}>
      <style>{`@media print { body * { visibility: hidden; } .quote-sheet, .quote-sheet * { visibility: visible; } .quote-sheet { position: absolute; left: 0; top: 0; width: 100%; } .no-print { display: none !important; } }`}</style>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: -0.3 }}>足場積算</div>
          <div style={{ fontSize: 11, color: C.sub }}>戸建・くさび式 / 4面</div>
        </div>
        <div style={{ height: 3, background: C.amber, borderRadius: 2, marginBottom: 14 }} />

        <div style={{ background: C.chip, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 11, color: C.sub }}>
          ※ 数値はサンプルです。実際の現場の寸法に書き換えてご利用ください。
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {["A", "B"].map((t) => (
            <button key={t} onClick={() => setType(t)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${type === t ? C.amber : C.line}`, background: type === t ? C.amber : "#fff", color: type === t ? C.amberInk : C.sub, fontWeight: 700, fontSize: 13 }}>
              {t}タイプ <span style={{ fontFamily: mono, fontWeight: 400, fontSize: 11 }}>({KOMA[t]}/{LAYER[t]})</span>
            </button>
          ))}
        </div>

        <Section title="建物・高さ">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <Field label="軒天高" val={nokiten} set={setNokiten} />
            <Field label="基礎高" val={kiso} set={setKiso} />
            <button onClick={() => setRoof(!roof)} style={{ flex: "0 0 auto", padding: "9px 12px", borderRadius: 8, border: `1px solid ${roof ? C.amber : C.line}`, background: roof ? C.amber : "#fff", color: roof ? C.amberInk : C.sub, fontWeight: 700, fontSize: 12, height: 38 }}>屋根作業 {roof ? "有" : "無"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.sub, flex: "0 0 auto" }}>各段の手摺</span>
            {[1, 2].map((r) => (
              <button key={r} onClick={() => setRails(r)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${rails === r ? C.amber : C.line}`, background: rails === r ? C.amber : "#fff", color: rails === r ? C.amberInk : C.sub, fontWeight: 700, fontSize: 12 }}>{r}本</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.sub, flex: "0 0 auto" }}>昇降階段</span>
            <button onClick={() => setStairs(!stairs)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${stairs ? C.amber : C.line}`, background: stairs ? C.amber : "#fff", color: stairs ? C.amberInk : C.sub, fontWeight: 700, fontSize: 12 }}>{stairs ? "設置する" : "設置しない"}</button>
          </div>
        </Section>

        <Section title="各面（長さ・軒の出・敷地幅）">
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            {FACE_KEYS.map((k) => (
              <div key={k} style={{ border: `1px solid ${R.built[k] ? C.line : "#e6a2a2"}`, borderRadius: 10, padding: 10, background: R.built[k] ? C.chip : "#faf1f1" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{k}面</span>
                  {!R.built[k] && <span style={{ fontSize: 10, color: C.red }}>長さ未入力 → 組立なし</span>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Field label="長さ" val={faces[k].len} set={(v) => setFaces({ ...faces, [k]: { ...faces[k], len: v } })} />
                  <Field label="軒の出" val={faces[k].noki} set={(v) => setFaces({ ...faces, [k]: { ...faces[k], noki: v } })} />
                  <Field label="敷地幅" val={faces[k].shiki} set={(v) => setFaces({ ...faces, [k]: { ...faces[k], shiki: v } })} />
                </div>
              </div>
            ))}
          </div>
        </Section>

        <ResultCard title="高さ図解（断面）" hero>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {FACE_KEYS.map((k) => (
              <button
                key={k}
                onClick={() => setHeightDir(k)}
                style={{
                  flex: 1, padding: "6px 0", borderRadius: 8, fontSize: 12, fontWeight: 700,
                  border: `1px solid ${heightDir === k ? C.amber : C.line}`,
                  background: heightDir === k ? C.amber : "#fff",
                  color: heightDir === k ? C.amberInk : (R.built[k] ? C.sub : "#b4bac2"),
                }}
              >
                {k}面
              </button>
            ))}
          </div>
          <HeightDiagram kiso={parseInt(kiso) || 0} nokiten={parseInt(nokiten) || 0} noki={parseInt(faces[heightDir].noki) || 0} roof={roof} jack={H.jack} type={type} standoff={R.tsuke[heightDir]} lowestKoma={H.lowestKoma} rails={rails} hane={R.faceRows.find((f) => f.name === heightDir)?.f.hane} />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11, color: C.sub }}>
            <span>水切りつら <b style={{ fontFamily: mono, color: C.ink }}>{H.offset >= 0 ? "+" : ""}{H.offset}</b></span>
            <span>段数 <b style={{ fontFamily: mono, color: C.ink }}>{H.danCount}</b></span>
            <span>総コマ <b style={{ fontFamily: mono, color: C.ink }}>{H.totalKoma}</b></span>
            {H.negarami && <span>根がらみ <b style={{ fontFamily: mono, color: C.red }}>必要</b></span>}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: C.sub, lineHeight: 1.7 }}>
            <div>使用支柱（1本あたり）</div>
            <div>外柱：<b style={{ fontFamily: mono, color: C.ink }}>{describeKomaList(H.komaList, type)}</b></div>
            <div>内柱：<b style={{ fontFamily: mono, color: C.ink }}>{describeKomaList(H.innerKomaList, type)}</b></div>
          </div>
        </ResultCard>

        <ResultCard title="平面 割り付け図（4面）">
          <PlanDiagram bw={R.ewLen} bh={R.nsLen} tsuke={R.tsuke} spansEW={R.scEW} spansNS={R.scNS} built={R.built} hane={R.hane} />
          <div style={{ marginTop: 8 }}>
            {R.faceRows.map((f) => (
              <div key={f.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "3px 0", fontSize: 12 }}>
                <span><b>{f.name}面</b> <span style={{ color: C.sub }}>L={f.len} / {f.spans.length}スパン</span></span>
                <span style={{ fontFamily: mono }}>離れ {f.standoff}
                  {f.f.hane && <span style={{ color: C.red, marginLeft: 6, fontWeight: 700 }}>ハネ出し</span>}
                  {!f.f.hane && f.f.over && <span style={{ color: C.red, marginLeft: 6 }}>敷地超過</span>}
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 12, color: C.sub }}>組立の延べ面積</span>
            <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 16, color: C.ink }}>{R.nobeArea} ㎡</span>
          </div>
        </ResultCard>

        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
          <button onClick={() => setMatOpen(!matOpen)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, background: "#fff", border: 0 }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>資材リスト（合計）</span>
              <span style={{ fontSize: 10, color: C.red }}>概算・要検証</span>
            </span>
            <span style={{ fontFamily: mono, color: C.sub }}>{matOpen ? "▲ 閉じる" : "▼ 展開"}</span>
          </button>
          {matOpen && (
            <div style={{ padding: "0 12px 12px" }}>
              {grps.map((g) => (
                <div key={g} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: C.sub, letterSpacing: 0.4, borderBottom: `1px solid ${C.line}`, paddingBottom: 2, marginBottom: 2 }}>{g}</div>
                  {R.materials.filter((m) => m.grp === g).map((m) => (<Row key={m.name} k={m.name} v={String(m.qty)} warn={m.name.includes("根がらみ支柱")} />))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
          <button onClick={() => setFaceOpen(!faceOpen)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, background: "#fff", border: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>面別内訳</span>
            <span style={{ fontFamily: mono, color: C.sub }}>{faceOpen ? "▲ 閉じる" : "▼ 展開"}</span>
          </button>
          {faceOpen && (
            <div style={{ padding: "0 12px 12px", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ color: C.sub }}>
                  <th style={{ textAlign: "left", padding: "6px 4px", fontWeight: 600 }}>部材</th>
                  {FACE_KEYS.map((k) => <th key={k} style={{ textAlign: "right", padding: "6px 4px", fontWeight: 600 }}>{k}</th>)}
                  <th style={{ textAlign: "right", padding: "6px 4px", fontWeight: 700, color: C.ink }}>計</th>
                </tr></thead>
                <tbody>
                  {PERFACE_ROWS.map((row) => (
                    <tr key={row} style={{ borderTop: `1px solid ${C.line}` }}>
                      <td style={{ padding: "6px 4px" }}>{row}</td>
                      {FACE_KEYS.map((k) => <td key={k} style={{ textAlign: "right", padding: "6px 4px", fontFamily: mono, color: C.sub }}>{R.faceMat[k][row]}</td>)}
                      <td style={{ textAlign: "right", padding: "6px 4px", fontFamily: mono, fontWeight: 700 }}>{R.faceTot[row]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <Section title="断面・平面・資材リストの保存 / 共有">
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 8 }}>
            保存・共有は下の「見積書」欄の宛先（お客様）＝元請名、現場名として記録されます。
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleSaveProject}
              style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: 0, background: C.ink, color: "#fff", fontWeight: 700, fontSize: 13 }}
            >
              {user ? "この内容を保存" : "保存（要LINEログイン）"}
            </button>
            <button
              onClick={handleShareDiagrams}
              style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", color: C.ink, fontWeight: 700, fontSize: 13 }}
            >
              画像で共有{" "}
              <span style={{ fontWeight: 400, fontSize: 10 }}>
                {!user ? "（要ログイン）" : pdfStatus.plan !== "none" ? "（無制限）" : `（残り${pdfStatus.remainingFree}回）`}
              </span>
            </button>
          </div>
          {savedProjects.length > 0 && (
            <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
              <button onClick={() => setSavedOpen(!savedOpen)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent", border: 0, padding: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>保存済み（{savedProjects.length}件）</span>
                <span style={{ fontFamily: mono, color: C.sub, fontSize: 12 }}>{savedOpen ? "▲ 閉じる" : "▼ 展開"}</span>
              </button>
              {savedOpen && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
                  {savedProjects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleLoadProject(p)}
                      style={{ textAlign: "left", padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff" }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{p.client_name || "元請未設定"} / {p.site_name || "現場未設定"}</div>
                      <div style={{ fontSize: 10, color: C.sub }}>{new Date(p.created_at).toLocaleString("ja-JP")}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="見積書（客先提出用）">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: C.sub }}>自社情報：{settings.jisha || "未設定"}</span>
            <button onClick={() => (user ? setSettingsOpen(true) : startLineLogin())} style={{ fontSize: 12, color: C.ink, background: C.chip, border: `1px solid ${C.line}`, borderRadius: 8, padding: "5px 10px", fontWeight: 700 }}>⚙ 設定{user ? "" : "（要ログイン）"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <TextField label="宛先（お客様）" val={quote.atesaki} set={(v) => setQuote({ ...quote, atesaki: v })} ph="〇〇様" />
            <TextField label="現場名" val={quote.genba} set={(v) => setQuote({ ...quote, genba: v })} ph="〇〇邸" />
          </div>
          <Field label="足場 単価（円/㎡）" val={quote.tanka} set={(v) => setQuote({ ...quote, tanka: v })} unit="円/㎡" />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", fontSize: 12 }}>
            <span style={{ color: C.sub }}>足場工事一式　{R.nobeArea}㎡ × {tankaN.toLocaleString()}</span>
            <span style={{ fontFamily: mono, fontWeight: 700 }}>¥{kingaku.toLocaleString()}</span>
          </div>
          {items.map((it, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${C.line}` }}>
              <TextField label="品名" val={it.name} set={(v) => setItem(i, "name", v)} ph="メッシュ等" />
              <Field label="数量" val={it.qty} set={(v) => setItem(i, "qty", v)} unit="" />
              <Field label="単価" val={it.price} set={(v) => setItem(i, "price", v)} unit="円" />
              <button onClick={() => delItem(i)} style={{ flex: "0 0 auto", padding: "9px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", color: C.red, fontWeight: 700, height: 38 }}>×</button>
            </div>
          ))}
          <button onClick={addItem} style={{ width: "100%", marginTop: 8, padding: "9px 0", borderRadius: 8, border: `1px dashed ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700, fontSize: 12 }}>＋ 項目を追加（シート・昇降階段など）</button>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
            <Field label="値引き" val={discount.amount} set={(v) => setDiscount({ ...discount, amount: v })} unit="円" />
            <div style={{ flex: "1.4 1 0" }}>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>端数を丸める（切り下げ）</div>
              <div style={{ display: "flex", gap: 4 }}>
                {[[0, "なし"], [10, "0"], [100, "00"], [1000, "000"], [10000, "0000"]].map(([u, lb]) => (
                  <button key={u} onClick={() => setDiscount({ ...discount, unit: u })} style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: `1px solid ${discount.unit === u ? C.amber : C.line}`, background: discount.unit === u ? C.amber : "#fff", color: discount.unit === u ? C.amberInk : C.sub, fontWeight: 700, fontSize: 11 }}>{lb}</button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
            <QRow k="小計（税抜）" v={grandTotal} />
            {nebikiTotal > 0 ? <QRow k="値引き" v={-nebikiTotal} red /> : null}
            <QRow k="税抜価格" v={zeinuki} />
            <QRow k="消費税（10%）" v={zei} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0 0" }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>総額</span>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 20 }}>¥{sougaku.toLocaleString()}</span>
            </div>
          </div>
          <button onClick={makeQuote} style={{ width: "100%", marginTop: 6, padding: "12px 0", borderRadius: 10, border: 0, background: C.amber, color: C.amberInk, fontWeight: 800, fontSize: 14 }}>
            見積書を作成{" "}
            <span style={{ fontWeight: 400, fontSize: 11 }}>
              {!user
                ? "（要LINEログイン）"
                : pdfStatus.plan !== "none"
                ? "（ご契約プラン・無制限）"
                : `（無料 今月残り${pdfStatus.remainingFree}回）`}
            </span>
          </button>
          {msg ? <div style={{ fontSize: 11, color: C.red, marginTop: 6, textAlign: "center" }}>{msg}</div> : null}
          {user && pdfStatus.plan === "none" && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.line}` }}>
              <button
                onClick={() => startCheckout("monthly").catch((e) => setMsg(`決済ページを開けませんでした: ${e.message}`))}
                style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", color: C.ink, fontWeight: 700, fontSize: 12 }}
              >
                月額500円で無制限
              </button>
              <button
                onClick={() => startCheckout("annual").catch((e) => setMsg(`決済ページを開けませんでした: ${e.message}`))}
                style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", color: C.ink, fontWeight: 700, fontSize: 12 }}
              >
                年額5,000円で無制限
              </button>
            </div>
          )}
          {user && pdfStatus.plan !== "none" && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.line}`, textAlign: "center" }}>
              <button
                onClick={() => openBillingPortal().catch((e) => setMsg(`契約管理ページを開けませんでした: ${e.message}`))}
                style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700, fontSize: 12 }}
              >
                契約内容の確認・解約はこちら
              </button>
            </div>
          )}
        </Section>

        <button onClick={() => setMsg("AshiBase資材管理への接続は準備中です")} style={{ width: "100%", padding: "13px 0", borderRadius: 10, border: 0, background: C.ink, color: "#fff", fontWeight: 800, fontSize: 14 }}>
          この部材を AshiBase で資材管理 <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.7 }}>（接続準備中）</span>
        </button>
        <div style={{ textAlign: "center", fontSize: 10, color: C.sub, marginTop: 8 }}>概算です。実施工は現調前提。</div>
        <div style={{ textAlign: "center", fontSize: 10, marginTop: 10 }}>
          <a href="/tokushoho.html" style={{ color: C.sub }}>特定商取引法に基づく表示</a>
        </div>

        {pdfView && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 60, overflow: "auto", padding: 14 }}>
            <div style={{ maxWidth: 520, margin: "0 auto" }}>
              <div className="quote-sheet" style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 8px 30px rgba(0,0,0,.2)" }}>
                <div style={{ textAlign: "center", fontSize: 20, fontWeight: 800, letterSpacing: 6, marginBottom: 18 }}>御 見 積 書</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, borderBottom: `1px solid ${C.ink}`, paddingBottom: 2 }}>{quote.atesaki || "お客様"} 御中</div>
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>現場：{quote.genba || "—"}</div>
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, textAlign: "right" }}>{today}</div>
                </div>
                <div style={{ fontSize: 12, marginBottom: 10 }}>下記の通り御見積り申し上げます。</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ background: "#f2f4f7" }}>
                    <th style={{ textAlign: "left", padding: "8px 6px", border: `1px solid ${C.line}` }}>項目</th>
                    <th style={{ textAlign: "right", padding: "8px 6px", border: `1px solid ${C.line}` }}>数量</th>
                    <th style={{ textAlign: "right", padding: "8px 6px", border: `1px solid ${C.line}` }}>金額</th>
                  </tr></thead>
                  <tbody>
                    {allLines.map((l, i) => (
                      <tr key={i}>
                        <td style={{ padding: "9px 6px", border: `1px solid ${C.line}` }}>{l.name}</td>
                        <td style={{ textAlign: "right", padding: "9px 6px", border: `1px solid ${C.line}`, fontFamily: mono }}>{l.qtyText}</td>
                        <td style={{ textAlign: "right", padding: "9px 6px", border: `1px solid ${C.line}`, fontFamily: mono }}>{l.amount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginLeft: "auto", width: 240, marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}><span style={{ color: C.sub }}>税抜価格</span><span style={{ fontFamily: mono }}>¥{zeinuki.toLocaleString()}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}><span style={{ color: C.sub }}>消費税(10%)</span><span style={{ fontFamily: mono }}>¥{zei.toLocaleString()}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, padding: "6px 0 0", borderTop: `2px solid ${C.ink}`, marginTop: 4 }}><span>総額</span><span style={{ fontFamily: mono }}>¥{sougaku.toLocaleString()}</span></div>
                </div>
                <div style={{ marginTop: 20, textAlign: "right", fontSize: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{settings.jisha || "（自社名）"}</div>
                  {settings.jusho ? <div style={{ color: C.sub }}>{settings.jusho}</div> : null}
                  {(settings.tel || settings.tanto) ? <div style={{ color: C.sub }}>{settings.tel}{settings.tanto ? `　担当：${settings.tanto}` : ""}</div> : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <div style={{ width: 42, height: 42, background: C.ink, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 8 }}>QR</div>
                  <div style={{ fontSize: 10, color: C.sub }}>Powered by <b style={{ color: C.ink }}>AshiBase</b><br />足場積算・資材管理</div>
                </div>
              </div>
              <div className="no-print" style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={downloadQuote} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: 0, background: C.amber, color: C.amberInk, fontWeight: 800 }}>画像で保存</button>
                <button onClick={shareQuote} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: 0, background: "#06C755", color: "#fff", fontWeight: 800 }}>LINEで共有</button>
                <button onClick={() => setPdfView(false)} style={{ flex: "0 0 auto", padding: "12px 16px", borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700 }}>閉じる</button>
              </div>
            </div>
          </div>
        )}

        {settingsOpen && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 60, overflow: "auto", padding: 14 }}>
            <div style={{ maxWidth: 460, margin: "40px auto 0" }}>
              <div style={{ background: "#fff", borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>設定（自社情報）</div>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 14 }}>見積書に自動で反映されます</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <TextField label="自社名" val={settings.jisha} set={(v) => setSettings({ ...settings, jisha: v })} ph="株式会社〇〇" />
                  <TextField label="住所" val={settings.jusho} set={(v) => setSettings({ ...settings, jusho: v })} />
                  <TextField label="電話番号" val={settings.tel} set={(v) => setSettings({ ...settings, tel: v })} />
                  <TextField label="担当者" val={settings.tanto} set={(v) => setSettings({ ...settings, tanto: v })} />
                </div>
                <button onClick={() => { saveSettings(settings); setSettingsOpen(false); }} style={{ width: "100%", marginTop: 16, padding: "12px 0", borderRadius: 10, border: 0, background: C.ink, color: "#fff", fontWeight: 800 }}>保存して閉じる</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
