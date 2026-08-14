project = "capnp-ts"
copyright = "2026, Rohit Goswami"
author = "Rohit Goswami"
release = "0.1.0-dev"

extensions = [
    "sphinx_copybutton",
    "sphinx_design",
    "myst_parser",
    "sphinxcontrib.mermaid",
]

templates_path = ["_templates"]
exclude_patterns = ["_build"]

myst_enable_extensions = ["colon_fence", "deflist"]

html_theme = "shibuya"
html_static_path = ["_static"]
html_title = "capnp-ts documentation"
html_baseurl = "https://capnp-ts.rgoswami.me/"

html_context = {
    "source_type": "github",
    "source_user": "HaoZeke",
    "source_repo": "capnp-ts",
    "source_version": "main",
    "source_docs_path": "/docs/orgmode/",
}

html_sidebars = {
    "**": [
        "sidebars/localtoc.html",
        "sidebars/repo-stats.html",
        "sidebars/edit-this-page.html",
    ],
}

html_theme_options = {
    "github_url": "https://github.com/HaoZeke/capnp-ts",
    "accent_color": "blue",
    "dark_code": True,
    "globaltoc_expand_depth": 1,
    "nav_links": [
        {
            "title": "Architecture",
            "url": "architecture",
            "summary": "Runtime and capnpc-ts",
        },
        {
            "title": "Ecosystem",
            "children": [
                {
                    "title": "c-capnproto",
                    "url": "https://c-capnproto.rgoswami.me",
                    "summary": "Pure C runtime and capnpc-c",
                    "external": True,
                },
                {
                    "title": "capnp-fortran",
                    "url": "https://capnp-fortran.rgoswami.me",
                    "summary": "Modern Fortran runtime and capnpc-fortran",
                    "external": True,
                },
                {
                    "title": "capnp-janet",
                    "url": "https://capnp-janet.rgoswami.me",
                    "summary": "Janet / C wire runtime",
                    "external": True,
                },
                {
                    "title": "Cap'n Proto",
                    "url": "https://capnproto.org",
                    "summary": "The reference C++ implementation and the wire spec",
                    "external": True,
                },
            ],
        },
    ],
}
