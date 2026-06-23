document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('theme-toggle');
    const currentTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.className = currentTheme;

    toggleSwitch.checked = currentTheme === 'dark';

    toggleSwitch.addEventListener('change', () => {
        const theme = toggleSwitch.checked ? 'dark' : 'light';
        document.documentElement.className = theme;
        localStorage.setItem('theme', theme);
    });
});