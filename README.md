# GNOME Global Menu

Menu global no estilo macOS para o GNOME Shell 50 (Wayland). Mostra a barra de
menus da janela em foco no lado esquerdo do painel superior.

## Como funciona

- `src/registrar.ts`: implementa `com.canonical.AppMenu.Registrar`, onde Qt,
  Electron, Chromium, Firefox e LibreOffice registram seus menus (DBusMenu).
  A janela é associada pelo ID X11 (XWayland) ou, em último caso, pelo PID.
- `src/sources/gtkMenuSource.ts`: lê menus GTK (`org.gtk.Menus`) usando os
  caminhos que o Mutter expõe para cada janela. Apps GTK4/libadwaita não
  exportam o menu hambúrguer, só as ações dele (`org.gtk.Actions`); para eles
  os menus são montados a partir dessas ações.
- `src/sources/gtkActionMenus.ts`: nomes de ação comuns nos apps GNOME
  (`app.about`, `win.undo`, …) e o menu e rótulo de cada um.
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

### Chrome e VS Code em Wayland nativo

No Wayland, o Chromium e o Electron só exportam o menu se o compositor tiver o
protocolo `org_kde_kwin_appmenu`, que o Mutter não implementa. O fork
[felixefelip/mutter](https://github.com/felixefelip/mutter) implementa esse
protocolo e expõe o endereço do menu em `Meta.Window`
(`dbus-appmenu-service-name` e `dbus-appmenu-object-path`). Sem o fork, a
extensão funciona como antes.

- `kde-appmenu`: o patch sobre o Mutter oficial do GNOME.
- `kde-appmenu-ubuntu`: o mesmo patch sobre o Mutter do Ubuntu, que é o que
  roda com o gnome-shell instalado.

Como cada app usa o protocolo:

- Chrome: manda o endereço pelo protocolo, janela por janela.
- VS Code/Electron: só confere se o protocolo existe e depois registra o
  menu no Registrar com um ID que não é de X11. A janela é encontrada pelo
  PID, então com várias janelas abertas pode aparecer o menu da janela errada.

Para testar na sessão aninhada sem instalar o fork (a versão do fork precisa
ser a mesma do Mutter instalado):

```sh
git clone -b kde-appmenu-ubuntu https://github.com/felixefelip/mutter ~/workspaces/mutter
sudo apt build-dep ~/workspaces/mutter
cd ~/workspaces/mutter && meson setup build --prefix=/usr \
    --libdir=lib/x86_64-linux-gnu -Dtests=disabled && ninja -C build
cd - && MUTTER_BUILD=~/workspaces/mutter/build npm run nested -- \
    google-chrome --ozone-platform=wayland
```

O comando depois de `--` é aberto dentro da sessão aninhada.

### Firefox

Em `about:config`, ative `widget.gtk.global-menu.enabled`. Para o caminho via
XWayland, inicie com `MOZ_ENABLE_WAYLAND=0 firefox`.
