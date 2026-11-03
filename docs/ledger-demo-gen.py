"""Generates docs/ledger-demo.svg: an animated Claude Code session, pure CSS.

Usage: python3 docs/ledger-demo-gen.py docs/ledger-demo.svg
"""
import math
import sys

T = 32.0            # cycle length, seconds
W, H = 880, 428
CW = 9.6            # 16px monospace advance (0.6em)
X0, Y0, LH = 24, 36, 23     # Y0: cap top sits 24px from the frame, like the side padding
FADE = 0.15

keyframes = {}


def col(c):
    return round(X0 + c * CW, 2)


def row(i):
    return Y0 + i * LH


def pct(t):
    return f"{max(0.0, min(100.0, t / T * 100)):.3f}".rstrip("0").rstrip(".") + "%"


def kf(name, body):
    keyframes[name] = body
    return f' style="animation-name: {name}"'


def tag(t):
    return f"{int(round(t * 10)):03d}"


def appear(t):
    return kf(f"in{tag(t)}", f"0%, {pct(t)} {{ opacity: 0; }} {pct(t + FADE)}, 100% {{ opacity: 1; }}")


def window(a, b):
    return kf(f"on{tag(a)}-{tag(b)}",
              f"0%, {pct(a)}, {pct(b + 0.05)}, 100% {{ opacity: 0; }} {pct(a + FADE)}, {pct(b)} {{ opacity: 1; }}")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def line(i, t, body):
    anim = appear(t) if t else ""
    return f'<g transform="translate(0 {row(i)})"{anim}>{body}</g>'


def text(c, s, cls=None, extra=""):
    klass = f' class="{cls}"' if cls else ""
    return f'<text x="{col(c)}"{klass}{extra}>{s}</text>'


def say(i, t, s, mark="●", mark_cls="acc"):
    return line(i, t, text(0, mark, mark_cls) + text(2, s))


def typed(i, t_line, cmd, ts, te, t_cursor_end):
    n = len(cmd)
    end = round(n * CW, 2)
    typing = kf(f"type{tag(ts)}",
                f"0%, {pct(ts)} {{ transform: translateX(0); animation-timing-function: steps({n}, end); }} "
                f"{pct(te)}, 100% {{ transform: translateX({end}px); }}")
    cursor = window(t_line, t_cursor_end)
    body = (text(0, "❯", "prompt")
            + text(2, esc(cmd), None, f' textLength="{end}" lengthAdjust="spacing"')
            + f'<g transform="translate({end} 0)"{typing}>'
            + f'<rect class="cover" x="{col(2)}" y="-17" width="700" height="24"/>'
            + f'<g class="cursor-on"{cursor}><rect class="cursor" x="{col(2)}" y="-15" width="{CW}" height="19"/></g>'
            + "</g>")
    return line(i, t_line, body)


def spinner():
    return f'<g transform="translate({col(0) + 5} -5)"><circle class="spinner" r="6"/></g>'


def progress(times, c):
    x0 = col(c)
    cells = []
    for k, t in enumerate(times):
        x = round(x0 + k * 14, 2)
        cells.append(f'<rect class="seg" x="{x}" y="-12" width="11" height="11" rx="2"/>')
        cells.append(f'<rect class="seg-on" x="{x}" y="-12" width="11" height="11" rx="2"{appear(t)}/>')
    return "".join(cells)


def helper(i, name, working, t_run, t_done, result, ok=True, bar=None, tint=False):
    mark, cls = ("✓", "ok") if ok else ("✗", "fail")
    run = spinner() + text(2, name, "agent") + text(15, esc(working), "dim")
    if bar:
        run += progress(bar, 16 + len(working))
    done = ""
    if tint:
        done += f'<rect class="tint-{cls}" x="14" y="-17" width="560" height="23" rx="4"/>'
    done += text(0, mark, cls) + text(2, name, "agent") + text(15, esc(result), cls if tint else None)
    return (f'<g transform="translate(0 {row(i)})">'
            f'<g class="run"{window(t_run, t_done)}>{run}</g>'
            f'<g{appear(t_done)}>{done}</g></g>')


def screen_one():
    return [
        typed(0, 0, "/ledger:go offline-queue-loss", 0.8, 2.2, 2.6),
        say(1, 2.6, 'Moved into worktree <tspan class="dim">.claude/worktrees/offline-queue-loss</tspan>'),
        say(2, 3.0, "Ledger loaded — next: write the plan"),
        say(4, 3.6, '<tspan class="b">Plan</tspan>'),
        line(5, 3.9, text(2, '<tspan class="dim">1.</tspan> A test that kills the app during a sync')),
        line(6, 4.2, text(2, '<tspan class="dim">2.</tspan> Save each item to disk before sending it')),
        line(7, 4.5, text(2, '<tspan class="dim">3.</tspan> Delete an item only after the server confirms it')),
        line(8, 4.9, text(2, "Approve?", "b")),
        typed(9, 5.3, "yes", 6.0, 6.3, 6.8),
        say(10, 6.8, "Plan written to the ledger"),
        helper(12, "researcher", "reading src/sync …", 7.4, 9.0, "cause found"),
        helper(13, "tests", "running the new test …", 9.2, 10.4,
               "1 failing — the test reproduces the bug", ok=False, tint=True),
        helper(14, "implementer", "writing the fix", 10.8, 13.2, "done", bar=[11.2, 11.6, 12.0, 12.4, 12.8]),
        helper(15, "tests", "running all tests …", 13.4, 14.6, "14 passing", tint=True),
        helper(16, "reviewer", "reading the diff …", 14.8, 16.0, "accepted"),
        line(18, 16.6, text(0, '<tspan class="b">Clear point.</tspan> Ledger updated. Type '
                               '<tspan class="link">/ledger:next</tspan> to continue.')),
        typed(19, 17.3, "/ledger:next", 17.9, 18.7, 19.0),
    ]


PR_AT = 26.9


def screen_two():
    return [
        say(0, 19.8, "Fresh session — ledger loaded, step 3 of 3"),
        helper(2, "implementer", "writing step 3", 20.4, 22.2, "done", bar=[20.7, 21.0, 21.3, 21.6, 21.9]),
        helper(3, "tests", "running all tests …", 22.4, 23.3, "15 passing", tint=True),
        helper(4, "reviewer", "reading the diff …", 23.5, 24.4, "accepted"),
        say(6, 24.9, "All steps done. Commit and open a PR?", "✓", "ok"),
        typed(7, 25.4, "yes", 26.1, 26.4, PR_AT),
        line(8, PR_AT, text(0, "✓", "ok") + text(2, "PR #42 opened", "ok b")),
        line(9, PR_AT + 0.2, text(2, "github.com/acme/app/pull/42", "link")),
    ]


SPARKLE = "M0 -1 C.12 -.12 .12 -.12 1 0 C.12 .12 .12 .12 0 1 C-.12 .12 -.12 .12 -1 0 C-.12 -.12 -.12 -.12 0 -1Z"


def celebration():
    y = row(8) - 6
    parts = []
    for k, (x, dy, size) in enumerate([(192, -4, 9), (212, 6, 6), (210, -14, 5)]):
        t = PR_AT + 0.1 + k * 0.15
        pop = kf(f"pop{k}",
                 f"0%, {pct(t)} {{ transform: scale(0); animation-timing-function: ease-out; }} "
                 f"{pct(t + 0.25)} {{ transform: scale(1.4); }} {pct(t + 0.45)}, 100% {{ transform: scale(1); }}")
        parts.append(f'<g transform="translate({x} {y + dy}) scale({size})">'
                     f'<path class="sparkle" d="{SPARKLE}"{pop}/></g>')
    pieces = 14
    for k in range(pieces):
        # Burst to the right and downward, into the empty part of the screen, not over the text above.
        a = math.radians(20 - k * 65 / (pieces - 1))
        r = 90 + (k * 53) % 130
        dx, dy = round(math.cos(a) * r), round(-math.sin(a) * r)
        spin = 180 + (k * 97) % 360
        t = PR_AT + 0.05 + (k % 3) * 0.05
        fly = kf(f"fly{k:02d}",
                 f"0%, {pct(t)} {{ opacity: 0; transform: translate(0, 0) rotate(0deg); }} "
                 f"{pct(t + 0.05)} {{ opacity: 1; transform: translate(0, 0) rotate(0deg); "
                 f"animation-timing-function: cubic-bezier(.2, .8, .4, 1); }} "
                 f"{pct(t + 0.7)} {{ opacity: 1; transform: translate({dx}px, {dy}px) rotate({spin // 2}deg); "
                 f"animation-timing-function: ease-in; }} "
                 f"{pct(t + 2.0)}, 100% {{ opacity: 0; transform: translate({round(dx * 1.3)}px, {dy + 90}px) "
                 f"rotate({spin}deg); }}")
        shape = ('<rect x="-4" y="-2" width="8" height="4" rx="1"' if k % 2 == 0 else '<circle r="2.6"')
        parts.append(f'<g transform="translate({200 + (k * 7) % 16} {y})">'
                     f'{shape} class="confetti c{k % 5}"{fly}/></g>')
    return "".join(parts)


STYLE = """
    svg * { animation-duration: 32s; animation-timing-function: linear; animation-iteration-count: infinite; }
    svg { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    text { font-size: 16px; fill: #1f2328; }
    .screen, .cover { fill: #ffffff; }
    .edge { stroke: #d1d9e0; }
    .dim { fill: #59636e; }
    .b { font-weight: 700; }
    .acc, .prompt { fill: #bc4c00; }
    .agent { fill: #8250df; }
    .ok { fill: #1a7f37; }
    .fail { fill: #cf222e; }
    .link { fill: #0969da; }
    .tint-ok { fill: #dafbe1; }
    .tint-fail { fill: #ffebe9; }
    .seg { fill: none; stroke: #d1d9e0; stroke-width: 1.5; }
    .seg-on { fill: #bc4c00; }
    .spinner { fill: none; stroke: #bc4c00; stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: 24 14;
               animation: spin 1s linear infinite; }
    .cursor { fill: #1f2328; opacity: .75; animation: blink 1s steps(1) infinite; }
    .sparkle { fill: #bf8700; }
    .c0 { fill: #bc4c00; } .c1 { fill: #0969da; } .c2 { fill: #1a7f37; } .c3 { fill: #8250df; } .c4 { fill: #bf8700; }
    .wipe-edge { fill: #bc4c00; }

    @media (prefers-color-scheme: dark) {
      text { fill: #e6edf3; }
      .screen, .cover { fill: #0d1117; }
      .edge, .seg { stroke: #3d444d; }
      .dim { fill: #9198a1; }
      .acc, .prompt, .seg-on, .wipe-edge, .c0 { fill: #f0883e; }
      .agent, .c3 { fill: #bc8cff; }
      .ok, .c2 { fill: #3fb950; }
      .fail { fill: #ff7b72; }
      .link, .c1 { fill: #58a6ff; }
      .tint-ok { fill: #0f2a1c; }
      .tint-fail { fill: #2d1418; }
      .spinner { stroke: #f0883e; }
      .cursor { fill: #e6edf3; }
      .sparkle, .c4 { fill: #e3b341; }
    }

    /* Static state = the final frame; the animations below replay the session over it. */
    .screen-1, .run, .cursor-on, .wipe, .confetti { opacity: 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes blink { 50% { opacity: 0; } }
@@KEYFRAMES@@
    @media (prefers-reduced-motion: reduce) {
      svg * { animation: none !important; }
    }
"""

DESC = ("A terminal running Claude Code with the ledger tool. "
        "You type /ledger:go offline-queue-loss. The agent moves into the worktree, loads the ledger and "
        "proposes a plan: 1. a test that kills the app during a sync, 2. save each item to disk before "
        "sending it, 3. delete an item only after the server confirms it. You type yes; the plan is written "
        "to the ledger. Helper agents work: the researcher finds the cause, the new test fails and reproduces "
        "the bug, the implementer writes the fix, 14 tests pass, the reviewer accepts. The agent says: Clear "
        "point. Ledger updated. Type /ledger:next to continue. You type /ledger:next; the screen clears and a "
        "fresh session loads the ledger at step 3 of 3, finishes it, and asks to commit and open a PR. "
        "You type yes, and PR #42 opens.")


def build():
    clip_top, clip_bottom = Y0 - 17, H - 4
    s1 = "\n      ".join(screen_one())
    s2 = "\n    ".join(screen_two())
    screen1_anim = kf("screen1", f"0%, {pct(19.5)} {{ opacity: 1; }} {pct(19.52)}, 100% {{ opacity: 0; }}")
    scroll = kf("scroll", f"0%, {pct(16.6)} {{ transform: translateY(0); }} "
                          f"{pct(16.75)}, {pct(17.3)} {{ transform: translateY(-{2 * LH}px); }} "
                          f"{pct(17.45)}, 100% {{ transform: translateY(-{3 * LH}px); }}")
    screen2_anim = kf("screen2", f"0%, {pct(19.5)} {{ opacity: 0; }} {pct(19.52)}, {pct(31.6)} {{ opacity: 1; }} "
                                 f"100% {{ opacity: 0; }}")
    wipe = kf("wipe", f"0%, {pct(18.95)} {{ opacity: 0; transform: translateY({clip_top}px); }} "
                      f"{pct(19.0)} {{ opacity: 1; transform: translateY({clip_top}px); "
                      f"animation-timing-function: ease-in; }} "
                      f"{pct(19.5)} {{ opacity: 1; transform: translateY({H}px); }} "
                      f"{pct(19.6)}, 100% {{ opacity: 0; transform: translateY({H}px); }}")
    party = celebration()
    frames = "\n".join(f"    @keyframes {name} {{ {body} }}" for name, body in keyframes.items())
    style = STYLE.replace("@@KEYFRAMES@@", frames)
    r = 12
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc">
  <title id="title">ledger in a Claude Code session: from /ledger:go to a pull request</title>
  <desc id="desc">{DESC}</desc>
  <style>{style}  </style>
  <defs>
    <clipPath id="screen-area"><rect x="0" y="{clip_top}" width="{W}" height="{clip_bottom - clip_top}"/></clipPath>
  </defs>

  <rect class="screen edge" x=".75" y=".75" width="{W - 1.5}" height="{H - 1.5}" rx="{r}"/>

  <g clip-path="url(#screen-area)">
    <g class="screen-1"{screen1_anim}>
      <g{scroll}>
      {s1}
      </g>
    </g>
    <g class="wipe"{wipe}>
      <rect class="cover" x="0" y="-{H}" width="{W}" height="{H}"/>
      <rect class="wipe-edge" x="0" y="-3" width="{W}" height="3"/>
    </g>
  </g>

  <g{screen2_anim}>
    {s2}
    {party}
  </g>
</svg>
"""


if __name__ == "__main__":
    out = build()
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        f.write(out)
