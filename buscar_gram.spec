# buscar_gram.spec
# PyInstaller spec to build a standalone single-file binary.

block_cipher = None

a = Analysis(
    ['buscar_gram.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'telethon',
        'telethon.sync',
        'telethon.tl.types',
        'telethon.errors',
        'dotenv',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'PIL'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='buscar_gram',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
)
