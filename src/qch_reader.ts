/*
 * @Coding: utf-8
 * @Description: 读取 Qt 帮助文件 (.qch)
 *
 * .qch 本质是一个 SQLite 数据库，解析用到的表：
 *   IndexTable    (Id, Name, Identifier, NamespaceId, FileId, Anchor)
 *   FileNameTable (FolderId, Name, FileId, Title)
 *   FileDataTable (Id, Data)   -- Data 为 qCompress 压缩（4 字节大端长度 + zlib 流）
 *
 * 表结构与筛选思路参考 https://github.com/danvratil/vscode-qtdoc (MIT, Daniel Vrátil)，
 * 这里自行实现只读的 SQLite 扫描，避免引入 sql.js / WASM 依赖。
 */

import * as fs from "fs";
import * as zlib from "zlib";

const SQLITE_MAGIC = "SQLite format 3\u0000";

export type SqlValue = string | number | Buffer | null;

/** IndexTable 与 FileNameTable 关联后的一行 */
export interface QchIndexRow {
    identifier: string;
    anchor: string;
    fileName: string;
    fileTitle: string;
}

export interface QchFileInfo {
    fileId: number;
    name: string;
    title: string;
}

interface PageCell {
    rowid: number;
    values: SqlValue[];
}

/**
 * 只读 SQLite 表扫描器
 *
 * 只实现 QCH 需要的功能：遍历 B 树叶子页、解析记录。不解析索引、不写、不做查询优化，
 * 所以只需要页头、cell、记录格式和溢出页这几部分。
 */
class SqliteReader {
    private readonly buf: Buffer;
    private readonly pageSize: number;
    private readonly usableSize: number;
    private readonly textEncoding: number;

    constructor(buf: Buffer) {
        if (buf.length < 100 || buf.toString("latin1", 0, 16) !== SQLITE_MAGIC) {
            throw new Error("不是有效的 SQLite 数据库");
        }
        const pageSizeRaw = buf.readUInt16BE(16);
        // 页大小字段为 1 时表示 65536
        this.pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
        this.usableSize = this.pageSize - buf.readUInt8(20);
        this.textEncoding = buf.readUInt32BE(56);
        this.buf = buf;
    }

    private pageOffset(pageNo: number): number {
        return (pageNo - 1) * this.pageSize;
    }

    /**
     * 读取 varint。注意 SQLite 的 varint 是大端序：每字节低 7 位，
     * 第一个字节存放最高位，第 9 个字节为完整的 8 位。
     */
    private static readVarint(buf: Buffer, off: number): { value: number; size: number } {
        let value = 0;
        for (let i = 0; i < 8; i++) {
            const b = buf[off + i];
            value = value * 128 + (b & 0x7f);
            if ((b & 0x80) === 0) {
                return { value, size: i + 1 };
            }
        }
        value = value * 256 + buf[off + 8];
        return { value, size: 9 };
    }

    /** 由 serial type 得到该列数据占用的字节数 */
    private static serialSize(type: number): number {
        if (type === 0 || type === 8 || type === 9 || type === 10 || type === 11) {
            return 0;
        }
        if (type >= 1 && type <= 4) {
            return type;
        }
        if (type === 5) {
            return 6;
        }
        if (type === 6 || type === 7) {
            return 8;
        }
        return Math.floor((type - 12) / 2);
    }

    private decodeText(bytes: Buffer): string {
        if (this.textEncoding === 2) {
            return bytes.toString("utf16le");
        }
        if (this.textEncoding === 3) {
            const swapped = Buffer.from(bytes);
            swapped.swap16();
            return swapped.toString("utf16le");
        }
        return bytes.toString("utf8");
    }

    /**
     * cell 的 payload 可能溢出到后续页。本地部分的大小由 SQLite 的
     * 局部 payload 公式决定：小 payload 全部本地存放，大 payload 按页大小
     * 取一个不超过 maxLocal 的值，其余放在溢出页链上。
     */
    private localPayloadSize(payloadSize: number): number {
        const usable = this.usableSize;
        const maxLocal = usable - 35;
        if (payloadSize <= maxLocal) {
            return payloadSize;
        }
        const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
        const k = minLocal + ((payloadSize - minLocal) % (usable - 4));
        return k <= maxLocal ? k : minLocal;
    }

    private readPayload(startOff: number, payloadSize: number): Buffer {
        const local = this.localPayloadSize(payloadSize);
        const payload = Buffer.allocUnsafe(payloadSize);
        this.buf.copy(payload, 0, startOff, startOff + local);

        let copied = local;
        if (local < payloadSize) {
            // 本地部分末尾 4 字节是第一个溢出页号，溢出页头 4 字节是下一页号
            let overflowPage = this.buf.readUInt32BE(startOff + local);
            while (copied < payloadSize && overflowPage !== 0) {
                const pageBase = this.pageOffset(overflowPage);
                const nextPage = this.buf.readUInt32BE(pageBase);
                const chunk = Math.min(this.usableSize - 4, payloadSize - copied);
                this.buf.copy(payload, copied, pageBase + 4, pageBase + 4 + chunk);
                copied += chunk;
                overflowPage = nextPage;
            }
        }
        return payload;
    }

    /** 解析一条记录：头部为 serial type 列表，其后依次是各列数据 */
    private decodeRecord(payload: Buffer): SqlValue[] {
        const headerSize = SqliteReader.readVarint(payload, 0);
        const types: number[] = [];
        let pos = headerSize.size;
        while (pos < headerSize.value) {
            const t = SqliteReader.readVarint(payload, pos);
            types.push(t.value);
            pos += t.size;
        }

        const values: SqlValue[] = [];
        let off = headerSize.value;
        for (const type of types) {
            const size = SqliteReader.serialSize(type);
            let value: SqlValue;
            if (type === 0) {
                value = null;
            } else if (type >= 1 && type <= 6) {
                // 整数按列宽存大端补码
                let acc = 0;
                for (let i = 0; i < size; i++) {
                    acc = acc * 256 + payload[off + i];
                }
                value = payload[off] & 0x80 ? acc - Math.pow(2, size * 8) : acc;
            } else if (type === 7) {
                value = payload.readDoubleBE(off);
            } else if (type === 8) {
                value = 0;
            } else if (type === 9) {
                value = 1;
            } else if (type >= 12 && type % 2 === 0) {
                value = payload.subarray(off, off + size);
            } else if (type >= 13) {
                value = this.decodeText(payload.subarray(off, off + size));
            } else {
                value = null;
            }
            values.push(value);
            off += size;
        }
        return values;
    }

    /** 深度优先遍历一张表的全部行（B 树叶子页 + 内部页） */
    public *scanTable(rootPage: number): IterableIterator<PageCell> {
        const stack: number[] = [rootPage];
        while (stack.length > 0) {
            const pageNo = stack.pop()!;
            const base = this.pageOffset(pageNo);
            // 第 1 页前面有 100 字节的数据库头
            const header = pageNo === 1 ? base + 100 : base;
            const type = this.buf.readUInt8(header);
            const cellCount = this.buf.readUInt16BE(header + 3);

            if (type === 5) {
                // 内部表页：cell 本身就是「4 字节左子页号 + varint(key)」，
                // 每个 cell 指针指向一个 cell，而不是像叶子页那样直接指向记录
                const ptrArray = header + 12;
                for (let i = 0; i < cellCount; i++) {
                    const cellOff = base + this.buf.readUInt16BE(ptrArray + i * 2);
                    stack.push(this.buf.readUInt32BE(cellOff));
                }
                // 页头第 8 字节是最右子页号
                stack.push(this.buf.readUInt32BE(header + 8));
            } else if (type === 13) {
                // 叶子表页：cell 指针相对页首
                const ptrArray = header + 8;
                for (let i = 0; i < cellCount; i++) {
                    let off = base + this.buf.readUInt16BE(ptrArray + i * 2);
                    const payloadSize = SqliteReader.readVarint(this.buf, off);
                    off += payloadSize.size;
                    const rowid = SqliteReader.readVarint(this.buf, off);
                    off += rowid.size;
                    yield {
                        rowid: rowid.value,
                        values: this.decodeRecord(this.readPayload(off, payloadSize.value))
                    };
                }
            } else {
                throw new Error("不支持的 SQLite 页类型: " + type);
            }
        }
    }
}

/** 读取 sqlite_master，得到 表名 -> 根页号 */
function readTableRoots(reader: SqliteReader): Map<string, number> {
    const roots = new Map<string, number>();
    for (const cell of reader.scanTable(1)) {
        const [type, name, , rootPage] = cell.values;
        if (type === "table" && typeof name === "string" && typeof rootPage === "number") {
            roots.set(name, rootPage);
        }
    }
    return roots;
}

/** 一个 .qch 帮助文件 */
export class QchReader {
    private constructor(
        private readonly reader: SqliteReader,
        private readonly roots: Map<string, number>
    ) { }

    public static open(qchFile: string): QchReader {
        const buf = fs.readFileSync(qchFile);
        const reader = new SqliteReader(buf);
        return new QchReader(reader, readTableRoots(reader));
    }

    /** FileId -> 文件名/标题 */
    public readFileNameTable(): Map<number, QchFileInfo> {
        const files = new Map<number, QchFileInfo>();
        const root = this.roots.get("FileNameTable");
        if (root === undefined) {
            return files;
        }
        for (const cell of this.reader.scanTable(root)) {
            const [, name, fileId, title] = cell.values;
            if (typeof fileId === "number" && typeof name === "string") {
                files.set(fileId, { fileId, name, title: typeof title === "string" ? title : "" });
            }
        }
        return files;
    }

    /** 索引表：符号名 -> 文档位置 */
    public readIndexRows(): QchIndexRow[] {
        const files = this.readFileNameTable();
        const rows: QchIndexRow[] = [];
        const root = this.roots.get("IndexTable");
        if (root === undefined) {
            return rows;
        }
        for (const cell of this.reader.scanTable(root)) {
            // IndexTable: Id, Name, Identifier, NamespaceId, FileId, Anchor
            const [, , identifier, , fileId, anchor] = cell.values;
            if (typeof identifier !== "string" || typeof fileId !== "number") {
                continue;
            }
            const file = files.get(fileId);
            if (!file) {
                continue;
            }
            rows.push({
                identifier,
                anchor: typeof anchor === "string" ? anchor : "",
                fileName: file.name,
                fileTitle: file.title
            });
        }
        return rows;
    }

    /** 按文件编号取内容，编号即 FileDataTable 的 rowid */
    public readFileData(fileId: number): Buffer | undefined {
        const root = this.roots.get("FileDataTable");
        if (root === undefined) {
            return undefined;
        }
        for (const cell of this.reader.scanTable(root)) {
            if (cell.rowid === fileId) {
                return QchReader.uncompress(cell.values[1]);
            }
        }
        return undefined;
    }

    /** 按文件名取内容，例如 qstring.html / style/offline.css */
    public readFileByName(name: string): Buffer | undefined {
        for (const file of this.readFileNameTable().values()) {
            if (file.name === name) {
                return this.readFileData(file.fileId);
            }
        }
        return undefined;
    }

    /**
     * 取出全部文件内容：文件名 -> 数据。
     *
     * FileDataTable 的 Id 是 INTEGER PRIMARY KEY，也就是 rowid 的别名，
     * 该列在记录里存的是 NULL，真实编号要从 rowid 取。
     * 这里一次扫描完成，避免逐文件重复遍历大表。
     */
    public readAllFiles(): Map<string, Buffer> {
        const root = this.roots.get("FileDataTable");
        const byId = new Map<number, Buffer>();
        if (root !== undefined) {
            for (const cell of this.reader.scanTable(root)) {
                const data = QchReader.uncompress(cell.values[1]);
                if (data) {
                    byId.set(cell.rowid, data);
                }
            }
        }

        const files = new Map<string, Buffer>();
        for (const file of this.readFileNameTable().values()) {
            const data = byId.get(file.fileId);
            if (data) {
                files.set(file.name, data);
            }
        }
        return files;
    }

    /** 解开 qCompress 数据 */
    private static uncompress(data: SqlValue): Buffer | undefined {
        if (!Buffer.isBuffer(data) || data.length <= 4) {
            return undefined;
        }
        try {
            return zlib.inflateSync(data.subarray(4));
        } catch (e) {
            return undefined;
        }
    }
}
