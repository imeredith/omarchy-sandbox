# Omarchy sandbox image.
#
# Hyprland needs a DRM device to allocate buffers, so instead of running it
# directly in the container, the container boots its own filesystem as a small
# QEMU VM: the guest kernel mounts the container's / over virtiofs and starts
# Omarchy (SDDM autologin -> uwsm -> Hyprland) on a virtio GPU rendered in
# software by Mesa. No host GPU or display is needed, and anything the guest
# writes lands in the container's writable layer, so removing the container
# throws the sandbox away.
#
# `osb` (the entrypoint) boots the VM and drives it: screenshots and input go
# through QEMU's QMP socket (virtual monitor, USB tablet and keyboard), and
# commands run in the guest's Hyprland session over SSH.

ARG ARCH_IMAGE=archlinux:latest
FROM ${ARCH_IMAGE}

# Extra packages to bake into the guest (space separated).
ARG EXTRA_PACKAGES=""

# Bootstrap the Omarchy repo and keyring, then restore signature checking.
RUN pacman-key --init && pacman-key --populate archlinux \
 && printf '\n[omarchy]\nSigLevel = Optional TrustAll\nServer = https://pkgs.omarchy.org/stable/$arch\n' >> /etc/pacman.conf \
 && pacman -Syu --noconfirm omarchy-keyring \
 && pacman-key --populate omarchy \
 && sed -i '/^SigLevel = Optional TrustAll$/d' /etc/pacman.conf

# The archlinux image skips man pages, docs and locales; a VM should be complete.
RUN sed -i '/^NoExtract/d' /etc/pacman.conf

# Omarchy itself. Bootloader and snapshot tooling is meaningless here: QEMU
# boots the kernel directly.
RUN pacman -S --noconfirm --needed \
      --assume-installed limine --assume-installed limine-mkinitcpio-hook \
      --assume-installed limine-snapper-sync --assume-installed snapper \
      base linux-omarchy mkinitcpio omarchy \
      mesa vulkan-swrast openssh sudo \
      grim slurp wtype wl-clipboard foot alacritty \
      networkmanager polkit \
      ${EXTRA_PACKAGES} \
 && yes | pacman -Scc

# The VM host side (QEMU + virtiofsd) and what omarchy-provision-user needs.
RUN pacman -S --noconfirm --needed \
      qemu-system-x86 qemu-system-x86-firmware qemu-img \
      qemu-hw-display-virtio-gpu qemu-hw-display-virtio-gpu-pci qemu-hw-display-virtio-vga \
      virtiofsd python xdg-user-dirs \
 && yes | pacman -Scc

COPY rootfs/ /

# Sandbox user (password "omarchy", passwordless sudo) with Omarchy's skel.
# The SSH key only ever travels between the container and its own VM.
RUN useradd -m -G wheel -s /bin/bash omarchy \
 && echo 'omarchy:omarchy' | chpasswd \
 && echo 'omarchy ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/10-omarchy \
 && chmod 440 /etc/sudoers.d/10-omarchy \
 && mkdir -p /etc/osb /workspace \
 && ssh-keygen -q -t ed25519 -N '' -C osb -f /etc/osb/id_ed25519 \
 && install -d -m 700 -o omarchy -g omarchy /home/omarchy/.ssh \
 && install -m 600 -o omarchy -g omarchy /etc/osb/id_ed25519.pub /home/omarchy/.ssh/authorized_keys \
 && chown omarchy:omarchy /workspace \
 && ln -s /workspace /home/omarchy/workspace

# Omarchy's ISO steps that make sense in a VM: login tweaks, services and the
# per-user setup (the rest of install/user/all.sh expects the full ISO
# package set, e.g. mise and chromium).
RUN bash /usr/share/omarchy/install/login/sddm.sh \
 && (bash /usr/share/omarchy/install/config/enable-services.sh || true) \
 && systemctl enable sshd.service \
 && systemctl set-default graphical.target \
 && runuser -u omarchy -- env HOME=/home/omarchy USER=omarchy OMARCHY_SETUP_CONTEXT=iso \
      OMARCHY_THEME_HEADLESS=1 OMARCHY_PATH=/usr/share/omarchy PATH=/usr/share/omarchy/bin:/usr/bin \
      bash -c 'cd ~ && xdg-user-dirs-update \
        && for step in theme xcompose git; do \
             bash "$OMARCHY_PATH/install/user/$step.sh" || echo "warning: user/$step.sh failed"; \
           done \
        && test -s ~/.local/state/omarchy/current/theme.name \
        && omarchy-done mark finalize-user'

# Predictable coordinates for agents: one monitor at scale 1.
RUN cat > /home/omarchy/.config/hypr/monitors.lua <<'EOF' && chown omarchy:omarchy /home/omarchy/.config/hypr/monitors.lua
-- os-sandbox: the VM has one virtio display; keep scale at 1 so screenshot
-- pixels map 1:1 onto pointer coordinates.
hl.env("GDK_SCALE", "1")
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })
EOF

# Initramfs that mounts the virtiofs root, using the sandbox hooks only.
RUN rm -f /etc/mkinitcpio.conf.d/omarchy_*.conf /etc/mkinitcpio.conf.d/thunderbolt_module.conf \
 && kver="$(ls /usr/lib/modules | head -n1)" \
 && mkinitcpio -k "$kver" -g /boot/initramfs-sandbox.img \
 && ln -sf "/usr/lib/modules/$kver/vmlinuz" /boot/vmlinuz-sandbox

RUN printf '# Root is the container filesystem, mounted over virtiofs by the initramfs.\n' > /etc/fstab \
 && ln -sf /usr/share/zoneinfo/UTC /etc/localtime \
 && echo 'LANG=en_US.UTF-8' > /etc/locale.conf \
 && sed -i 's/^#en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && : > /etc/machine-id

ENV OSB_WIDTH=1280 \
    OSB_HEIGHT=800 \
    OSB_MEMORY=4096 \
    OSB_CPUS=2

# 5900: VNC view of the VM display (no password; publish on localhost only).
EXPOSE 5900
VOLUME ["/workspace"]
ENTRYPOINT ["/usr/local/bin/osb", "boot"]
