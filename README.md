# GNOME Global Menu

Menu global no estilo macOS para o GNOME Shell 50 (Wayland). Mostra a barra de
menus da janela em foco no lado esquerdo do painel superior.

## Como funciona

- `src/registrar.ts`: implementa `com.canonical.AppMenu.Registrar`, onde Qt,
  Electron, Chromium, Firefox e LibreOffice registram seus menus (DBusMenu).
  A janela é associada pelo ID X11 (XWayland) ou, em último caso, pelo PID.
- `src/sources/gtkMenuSource.ts`: lê menus GTK (`org.gtk.Menus`) usando os
  caminhos que o Mutter expõe para cada janela.
- `src/sources/dbusMenuSource.ts`: cliente do protocolo `com.canonical.dbusmenu`.
- `src/sources/desktopMenuSource.ts`: menu mostrado quando a área de trabalho
  está em foco (como o Finder no macOS): app Arquivos e menus Go (pastas),
  Preferences (painéis do Configurações) e Help.
- `src/menuBar.ts`: desenha os menus no painel.
- `src/extension.ts`: acompanha a janela em foco e escolhe a fonte do menu.

## Desenvolvimento

```sh
npm install
npm run check        # checagem de tipos
npm run build        # gera build/
npm run install-ext  # copia para ~/.local/share/gnome-shell/extensions
```

### Testar numa sessão aninhada (recomendado)

Precisa do pacote `mutter-dev-bin` (`sudo apt install mutter-dev-bin`).

```sh
npm run install-ext
npm run nested   # abre o GNOME numa janela e já ativa a extensão nele
```

Abra os apps de dentro da janela aninhada (pelo Activities dela). Os apps
abertos fora dela continuam na sua sessão normal.

Os apps precisam ser abertos **depois** de a extensão estar ativa, porque eles
só procuram o Registrar ao iniciar.

Logs: na sessão aninhada aparecem no terminal que rodou `npm run nested`; na sessão normal, use `journalctl -f -o cat /usr/bin/gnome-shell | grep global-menu`.

### Firefox

Em `about:config`, ative `widget.gtk.global-menu.enabled`. Para o caminho via
XWayland, inicie com `MOZ_ENABLE_WAYLAND=0 firefox`.
