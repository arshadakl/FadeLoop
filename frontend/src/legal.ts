import "./styles.css";
const nav = document.createElement("header");
nav.className = "legal-brand-nav";
const brand = document.createElement("a");
brand.className = "brand";
brand.href = "/";
brand.setAttribute("aria-label", "FadeLoop home");
const mark = document.createElement("span");
mark.className = "brand-mark";
const image = document.createElement("img");
image.src = "/logo.svg"; image.alt = ""; image.width = image.height = 36;
mark.append(image);
const wordmark = document.createElement("span");
wordmark.className = "brand-wordmark";
wordmark.textContent = "FadeLoop";
brand.append(mark, wordmark); nav.append(brand);
document.querySelector(".doc")?.prepend(nav);
const button = document.createElement("button");
button.textContent = "Appearance";
button.className = "legal-theme";
button.onclick = () => {
  const theme = window.fadeTheme.get();
  window.fadeTheme.set(
    theme === "system" ? "light" : theme === "light" ? "dark" : "system",
  );
  button.textContent = `Appearance: ${window.fadeTheme.get()}`;
};
nav.append(button);
