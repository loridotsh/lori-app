"""Themed matplotlib charts for documents and PDFs: quiet axes, direct labels, one palette."""
from __future__ import annotations

from typing import Sequence

from .theme import HAIR, INK, MUTED, TEXT, WHITE, Theme


def _setup():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from matplotlib import font_manager

    # Use the first font that is really installed, so no warnings and no silent fallback surprises.
    available = {f.name for f in font_manager.fontManager.ttflist}
    family = next((n for n in ("Arial", "Liberation Sans", "Helvetica", "DejaVu Sans") if n in available), "DejaVu Sans")
    plt.rcParams.update({
        "font.family": [family],
        "font.size": 8.5,
        "text.color": f"#{TEXT}",
        "axes.labelcolor": f"#{MUTED}",
        "xtick.color": f"#{MUTED}",
        "ytick.color": f"#{MUTED}",
        "axes.edgecolor": f"#{HAIR}",
        "svg.fonttype": "none",
    })
    return plt


def render_chart(path: str, kind: str, categories: Sequence[str], series: dict[str, Sequence[float]],
                 theme: Theme, width_in: float, height_in: float, title: str | None = None,
                 value_format: str = "{:,.0f}", labels: bool = True, dpi: int = 220) -> str:
    plt = _setup()
    colors = [f"#{c}" for c in theme.series]
    names = list(series)
    fig, ax = plt.subplots(figsize=(width_in, height_in), dpi=dpi)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    if title:
        ax.set_title(title, loc="left", fontsize=10, fontweight="bold", color=f"#{INK}", pad=10)

    if kind == "pie":
        values = list(series[names[0]])
        wedges, _ = ax.pie(values, colors=colors[: len(values)], startangle=90, counterclock=False,
                           wedgeprops={"width": 0.38, "edgecolor": "white", "linewidth": 1.5})
        total = sum(values) or 1
        ax.legend(wedges, [f"{c}  {v / total:.0%}" for c, v in zip(categories, values)], loc="center left",
                  bbox_to_anchor=(1.0, 0.5), frameon=False, fontsize=8.5)
        ax.set_aspect("equal")
    elif kind == "hbar":
        import numpy as np

        positions = np.arange(len(categories))
        height = 0.7 / len(names)
        for i, name in enumerate(names):
            bars = ax.barh(positions + i * height - 0.35 + height / 2, series[name], height * 0.88,
                           color=colors[i % len(colors)], label=name)
            if labels:
                ax.bar_label(bars, labels=[value_format.format(v) for v in series[name]], padding=3,
                             fontsize=8, color=f"#{TEXT}")
        ax.set_yticks(positions)
        ax.set_yticklabels(categories)
        ax.invert_yaxis()
        ax.xaxis.grid(True, color=f"#{HAIR}", linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_xticks([])
        for side in ("top", "right", "bottom"):
            ax.spines[side].set_visible(False)
    else:
        import numpy as np

        positions = np.arange(len(categories))
        if kind == "line":
            for i, name in enumerate(names):
                ax.plot(positions, series[name], color=colors[i % len(colors)], linewidth=2, marker="o",
                        markersize=4, label=name)
                if labels and len(names) <= 2:
                    for x, y in zip(positions, series[name]):
                        ax.annotate(value_format.format(y), (x, y), textcoords="offset points", xytext=(0, 7),
                                    ha="center", fontsize=7.5, color=f"#{TEXT}")
        elif kind == "stacked":
            bottoms = np.zeros(len(categories))
            for i, name in enumerate(names):
                ax.bar(positions, series[name], 0.62, bottom=bottoms, color=colors[i % len(colors)], label=name)
                bottoms += np.array(series[name], dtype=float)
            if labels:
                for x, total in zip(positions, bottoms):
                    ax.annotate(value_format.format(total), (x, total), textcoords="offset points", xytext=(0, 4),
                                ha="center", fontsize=8, color=f"#{TEXT}")
        else:
            width = 0.72 / len(names)
            for i, name in enumerate(names):
                bars = ax.bar(positions + i * width - 0.36 + width / 2, series[name], width * 0.9,
                              color=colors[i % len(colors)], label=name)
                if labels:
                    ax.bar_label(bars, labels=[value_format.format(v) for v in series[name]], padding=3,
                                 fontsize=8, color=f"#{TEXT}")
        ax.set_xticks(positions)
        ax.set_xticklabels(categories)
        ax.yaxis.grid(True, color=f"#{HAIR}", linewidth=0.8)
        ax.set_axisbelow(True)
        ax.tick_params(axis="y", length=0)
        ax.tick_params(axis="x", length=0, pad=6)
        ax.yaxis.set_major_formatter(lambda v, _: value_format.format(v))
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.margins(y=0.12)
    if kind != "pie" and len(names) > 1:
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=min(len(names), 5), frameon=False,
                  fontsize=8.5, handlelength=1.0, columnspacing=1.6)
    fig.tight_layout()
    fig.savefig(path, dpi=dpi, facecolor="white", bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
    return path
