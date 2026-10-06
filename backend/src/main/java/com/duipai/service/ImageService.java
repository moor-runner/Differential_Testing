package com.duipai.service;

import com.duipai.config.DataPaths;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;

@Service
public class ImageService {
    private static final long MAX_BYTES = 10 * 1024 * 1024;
    private static final Set<String> FORMATS = Set.of("png", "jpeg", "jpg", "gif");
    private final DataPaths paths;
    public ImageService(DataPaths paths) { this.paths = paths; }

    public String upload(MultipartFile file) throws IOException {
        if (file.isEmpty()) throw new IllegalArgumentException("图片不能为空");
        if (file.getSize() > MAX_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "图片上限为 10 MiB");
        BufferedImage decoded;
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(file.getBytes()))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new IllegalArgumentException("仅支持有效的 PNG、JPEG、GIF 图片");
            ImageReader reader = readers.next();
            try {
                if (!FORMATS.contains(reader.getFormatName().toLowerCase())) throw new IllegalArgumentException("仅支持 PNG、JPEG、GIF 图片");
                reader.setInput(input, true, true);
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width < 1 || height < 1 || (long) width * height > 16_000_000) throw new IllegalArgumentException("图片像素总量须不超过 1600 万");
                decoded = reader.read(0);
            } finally { reader.dispose(); }
        } catch (IOException exception) { throw new IllegalArgumentException("图片无法解码，请选择有效图片", exception); }
        String filename = UUID.randomUUID() + ".png";
        Path path = paths.images().resolve(filename);
        try (OutputStream output = Files.newOutputStream(path, StandardOpenOption.CREATE_NEW)) {
            if (!ImageIO.write(decoded, "png", output)) throw new IOException("PNG encoder unavailable");
        } catch (IOException exception) { Files.deleteIfExists(path); throw exception; }
        return "/api/images/" + filename;
    }

    public Path get(String filename) {
        if (!filename.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png")) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "图片不存在");
        Path path = paths.images().resolve(filename).normalize();
        if (!path.startsWith(paths.images()) || !Files.isRegularFile(path) || Files.isSymbolicLink(path)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "图片不存在");
        return path;
    }
}
