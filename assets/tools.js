/* Registry of every tool on the site.
   To add a new tool: add an entry here and include
   <script src="assets/site.js" defer></script> in the new page's <head>.
   The navigation bar and the home page pick it up automatically. */
window.SITE = {
  name: "TSIS Tools",
  baseUrl: "https://tools.thesouthindianschool.in",
  school: { name: "The South Indian School", url: "https://thesouthindianschool.in" },
  developer: { name: "Samson Thomas", url: "https://samsonthoma.github.io/" },
  tools: [
    { title: "Utility Toolkit", href: "utility-toolkit.html", icon: "🧰", color: "#2563eb",
      desc: "Unit converter, password generator, Markdown previewer and timer." },
    { title: "AI Study Suite", href: "ai-study-suite.html", icon: "🧠", color: "#4f46e5",
      desc: "Note-taking guide and LLM learning suite to study smarter." },
    { title: "Vocabulary Game", href: "vocabulary-game.html", icon: "🔤", color: "#db2777",
      desc: "Match words with their meanings in a fun challenge." },
    { title: "Periodic Table Explorer", href: "periodic-table-explorer.html", icon: "⚗️", color: "#0891b2",
      desc: "Search and explore all 118 elements." },
    { title: "Solar System Explorer", href: "solar-system-explorer.html", icon: "🪐", color: "#ea580c",
      desc: "Explore the planets of our solar system." }
  ]
};
