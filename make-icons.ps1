# 从桌面图标生成扩展所需的 16/48/128 三档尺寸（原图已确认为 1254x1254 正方形）
Add-Type -AssemblyName System.Drawing
$src = 'D:\Users\YZY\Desktop\x-icon.png'
$out = 'C:\Users\YZY\ZCodeProject\x-ai-translator\icons'

$img = [System.Drawing.Image]::FromFile($src)
$side = [Math]::Min($img.Width, $img.Height)
Write-Output ("source size: {0}x{1}, using side {2}" -f $img.Width, $img.Height, $side)

# 居中裁剪为正方形（非正方形时防拉伸）
$crop = [System.Drawing.Bitmap]::new($side, $side)
$cg = [System.Drawing.Graphics]::FromImage($crop)
$srcRect = [System.Drawing.Rectangle]::new([int](($img.Width - $side) / 2), [int](($img.Height - $side) / 2), $side, $side)
$dstRect = [System.Drawing.Rectangle]::new(0, 0, $side, $side)
$cg.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$cg.Dispose()

foreach ($size in 16, 48, 128) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($crop, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save("$out\icon$size.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$crop.Dispose()
$img.Dispose()
Get-ChildItem $out | ForEach-Object { Write-Output ("{0}  {1} bytes" -f $_.Name, $_.Length) }
