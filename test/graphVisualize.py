import json
import os
import networkx as nx
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib import font_manager

for _cjk in ["Microsoft YaHei", "SimHei", "STHeiti", "WenQuanYi Micro Hei"]:
    if any(_cjk in f.name for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.sans-serif"] = [_cjk, "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        break

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(SCRIPT_DIR, "output", "example", "graph_data.json")

NODE_COLORS = {
    "Intent": "#4CAF50",
    "Action": "#2196F3",
    "Outcome": "#FF9800",
}

EDGE_STYLES = {
    "TRIGGERS": {"color": "#4CAF50", "style": "solid"},
    "LEADS_TO": {"color": "#2196F3", "style": "solid"},
    "DEPENDS_ON": {"color": "#9C27B0", "style": "dashed"},
    "RESULTS_IN": {"color": "#FF9800", "style": "solid"},
}


def short_label(node):
    """Build a concise display label from node data."""
    ntype = node["type"]
    if ntype == "Intent":
        text = node["label"]
        return text if len(text) <= 20 else text[:18] + "…"
    if ntype == "Action":
        tool = node["label"]
        args = node.get("properties", {}).get("arguments", {})
        detail = args.get("query") or args.get("url") or ""
        if len(detail) > 28:
            detail = detail[:26] + "…"
        return f"{tool}\n{detail}" if detail else tool
    if ntype == "Outcome":
        return node["label"]
    return node["id"][:12]


def build_graph(chains):
    G = nx.DiGraph()
    for chain in chains:
        for n in chain["nodes"]:
            G.add_node(n["id"], type=n["type"], label=short_label(n))

        for rel in chain["rels"]:
            for src in rel["from"]:
                for dst in rel["to"]:
                    G.add_edge(src, dst, rel_type=rel["type"])
    return G


def layout_graph(G):
    """Arrange nodes in layers: Intent left, Actions middle (top-to-bottom), Outcome right."""
    intents = [n for n, d in G.nodes(data=True) if d["type"] == "Intent"]
    actions = [n for n, d in G.nodes(data=True) if d["type"] == "Action"]
    outcomes = [n for n, d in G.nodes(data=True) if d["type"] == "Outcome"]

    # order actions by LEADS_TO chain
    ordered_actions = []
    leads_to = {}
    for u, v, d in G.edges(data=True):
        if d["rel_type"] == "LEADS_TO":
            leads_to[u] = v
    # find the head of the chain (action that is not a LEADS_TO target)
    targets = set(leads_to.values())
    heads = [a for a in actions if a not in targets]
    for head in heads:
        cur = head
        while cur and cur not in ordered_actions:
            ordered_actions.append(cur)
            cur = leads_to.get(cur)
    for a in actions:
        if a not in ordered_actions:
            ordered_actions.append(a)

    pos = {}
    x_intent, x_action, x_outcome = 0, 2, 4
    n_actions = len(ordered_actions)
    for i, nid in enumerate(intents):
        pos[nid] = (x_intent, 0)
    for i, nid in enumerate(ordered_actions):
        y = -i * 1.2
        pos[nid] = (x_action, y)
    for i, nid in enumerate(outcomes):
        mid_y = -(n_actions - 1) * 1.2 / 2
        pos[nid] = (x_outcome, mid_y)
    return pos


def draw(G, pos):
    fig, ax = plt.subplots(figsize=(14, max(8, len(G.nodes) * 0.9)))
    ax.set_title("Event Chain Graph", fontsize=16, fontweight="bold", pad=20)

    node_colors = [NODE_COLORS.get(G.nodes[n]["type"], "#ccc") for n in G.nodes]
    labels = {n: G.nodes[n]["label"] for n in G.nodes}

    nx.draw_networkx_nodes(
        G, pos, ax=ax,
        node_color=node_colors, node_size=2800,
        edgecolors="#333", linewidths=1.2, alpha=0.92,
    )
    nx.draw_networkx_labels(
        G, pos, labels, ax=ax,
        font_size=7, font_family="sans-serif",
    )

    for rel_type, style in EDGE_STYLES.items():
        edges = [(u, v) for u, v, d in G.edges(data=True) if d["rel_type"] == rel_type]
        if not edges:
            continue
        nx.draw_networkx_edges(
            G, pos, edgelist=edges, ax=ax,
            edge_color=style["color"], style=style["style"],
            arrows=True, arrowsize=16, arrowstyle="-|>",
            connectionstyle="arc3,rad=0.08", width=1.5, alpha=0.75,
            min_source_margin=28, min_target_margin=28,
        )

    legend_handles = [
        mpatches.Patch(color=c, label=t) for t, c in NODE_COLORS.items()
    ] + [
        plt.Line2D([0], [0], color=s["color"], linestyle=s["style"], linewidth=2, label=t)
        for t, s in EDGE_STYLES.items()
    ]
    ax.legend(handles=legend_handles, loc="upper left", fontsize=9, framealpha=0.9)

    ax.axis("off")
    plt.tight_layout()
    out_path = os.path.join(SCRIPT_DIR, "output", "example", "graph.png")
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"Graph saved to {out_path}")
    plt.show()


if __name__ == "__main__":
    with open(DATA_PATH, encoding="utf-8") as f:
        chains = json.load(f)
    G = build_graph(chains)
    pos = layout_graph(G)
    draw(G, pos)
