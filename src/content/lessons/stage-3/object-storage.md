# 对象存储与 S3 协议

如果说 NFS 是"网络上的一个目录"，对象存储就是"网络上的一个巨大字典"：给一个名字，存取一整块数据，没有目录、没有 inode、没有 `open()` 和 `seek()`。正因为语义极简，它能扩展到几千亿对象、EB 级容量，成为今天数据湖、备份、AI 数据集和云原生应用的默认存储。而 S3 协议，已经成了这个领域事实上的标准。

学完这一课，你能说清对象模型和文件系统的根本区别，理解"目录"只是前缀加分隔符造出来的错觉；在单机上用容器跑起一个 S3 兼容服务，用 `aws` CLI、`mc`、`s5cmd` 完成上传、列举、分片上传、预签名、版本控制和生命周期；看懂 SigV4 签名的结构，知道 S3 的一致性承诺，以及小对象和 LIST 为什么是对象存储的软肋。

## 对象模型

### 四个概念

| 概念 | 含义 | 例子 |
|---|---|---|
| Bucket（桶） | 命名空间和权限、策略的边界 | `ml-datasets` |
| Key（键） | 对象在桶内的唯一名字，任意 UTF-8 字符串，最长 1024 字节 | `imagenet/train/n01440764/0001.jpg` |
| Object（对象） | 数据本身，不可部分修改的整体，单个最大 5 TiB（AWS S3） | JPEG 的全部字节 |
| Metadata（元数据） | 系统元数据（大小、ETag、Content-Type、修改时间）和用户元数据（`x-amz-meta-*`） | `x-amz-meta-owner: alice` |

和文件相比，对象有三个关键差别：

1. **不可原地修改**。想改对象中间的 1 个字节，只能重新上传整个对象。没有 `seek()` 后写，也没有追加写（个别实现有扩展，但不是 S3 标准）；
2. **整体可见**。上传过程中其他人看不到"写了一半"的对象，要么是旧版本，要么是完整的新版本；
3. **扁平命名空间**。桶里只有 key 到对象的映射，没有目录树。

### "目录"是一种错觉

打开任何 S3 控制台，你都会看到文件夹。但在服务端，下面这三个对象只是三个恰好带斜杠的字符串：

```text
imagenet/train/n01440764/0001.jpg
imagenet/train/n01440764/0002.jpg
imagenet/val/0001.jpg
```

"文件夹"是客户端用 LIST 请求的 `prefix` 和 `delimiter` 参数造出来的：列举前缀 `imagenet/`、分隔符 `/`，服务端把第一个 `/` 之后还有内容的 key 折叠成 `CommonPrefixes`（显示为文件夹）。这个错觉会在几个地方露馅：

| 文件系统操作 | 对象存储里的真相 |
|---|---|
| `mkdir dir` | 没有这回事。有的工具会创建一个名为 `dir/` 的 0 字节对象来"占位" |
| `mv dir newdir` | 逐个对象 COPY 再 DELETE，100 万个对象就是 200 万次请求，**不是原子的** |
| `rm -r dir` | 先 LIST 出所有 key，再批量 DELETE |
| `ls dir` 统计大小 | LIST 出全部对象累加，没有现成的目录大小 |

> [!WARNING] 别把对象存储当文件系统用
> 用 s3fs 之类的 FUSE 工具把桶挂成目录很方便，但每次 `ls` 都是 LIST、每次改文件都是重传整个对象、`mv` 目录不是原子的。跑数据库、做频繁的小文件修改，结果只会又慢又不可靠。需要 POSIX 语义又想用对象存储的容量，看[元数据与分布式文件系统](/learn/distributed-fs)里的 JuiceFS 这类方案。

## REST 语义

S3 是一套基于 HTTP 的 REST API，核心操作只有几个：

| 操作 | HTTP | 说明 |
|---|---|---|
| PutObject | `PUT /bucket/key` | 上传整个对象，覆盖同名对象 |
| GetObject | `GET /bucket/key` | 下载，支持 `Range: bytes=0-1023` 读取片段 |
| HeadObject | `HEAD /bucket/key` | 只取元数据，不取数据 |
| ListObjectsV2 | `GET /bucket?list-type=2&prefix=...&delimiter=/` | 按 key 字典序列举，每页最多 1000 个 |
| DeleteObject | `DELETE /bucket/key` | 删除；另有 DeleteObjects 一次删除最多 1000 个 |
| CopyObject | `PUT /bucket/key` + `x-amz-copy-source` 头 | 服务端复制，数据不经过客户端 |

URL 有两种风格：**虚拟主机风格**（`https://bucket.s3.example.com/key`，AWS 默认）和**路径风格**（`https://s3.example.com/bucket/key`）。自建对象存储大多用路径风格，因为不需要为每个桶配置泛域名 DNS 和证书。

## 动手：单机跑一个 S3 服务

### 启动 RustFS

团队的开发测试环境用 [RustFS](https://github.com/rustfs/rustfs) 替代 MinIO：它用 Rust 编写，兼容 S3，单机一个容器就能跑。容器内以 UID 10001 运行，挂载的目录要先改好属主：

```bash
mkdir -p ~/rustfs/{data,logs} && cd ~/rustfs
sudo chown -R 10001:10001 data logs
docker run -d --name rustfs --restart always \
  -p 9000:9000 -p 9001:9001 \
  -v $PWD/data:/data -v $PWD/logs:/logs \
  rustfs/rustfs:latest
docker logs rustfs | tail -5
```

9000 是 S3 API 端口，9001 是 Web 控制台（`http://<虚拟机IP>:9001`），默认账号密码都是 `rustfsadmin`。生产和长期使用请固定镜像版本号，而不是 `latest`。

> [!NOTE] 为什么不直接用 MinIO
> MinIO 长期是自建 S3 的首选，但它的社区版近几年不断收缩：控制台的管理功能被移除，二进制和镜像的发布方式也做了调整。已有的 MinIO 仍然可以用（命令是 `docker run -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin -v $PWD/minio:/data quay.io/minio/minio server /data --console-address :9001`），本课所有 S3 命令对两者都适用。选型时以各项目的最新公告为准。

### 配置 AWS CLI

Ubuntu 24.04 的软件源里没有 AWS CLI v2，用官方安装包：

```bash
sudo apt install -y unzip
curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip -q awscliv2.zip && sudo ./aws/install
aws --version
```

为本地服务单独建一个 profile：

```ini title="~/.aws/config"
[profile local]
region = us-east-1
endpoint_url = http://127.0.0.1:9000
request_checksum_calculation = when_required
response_checksum_validation = when_required
s3 =
    addressing_style = path
```

```ini title="~/.aws/credentials"
[local]
aws_access_key_id = rustfsadmin
aws_secret_access_key = rustfsadmin
```

```bash
export AWS_PROFILE=local
```

`addressing_style = path` 强制路径风格；两个 `checksum` 选项是因为 AWS CLI 2.23 起默认给每个请求附加新的完整性校验头，部分 S3 兼容实现还不认识，会报错，设成 `when_required` 恢复旧行为。

### 基本操作

```bash
aws s3 mb s3://demo
echo "hello object" > hello.txt
aws s3 cp hello.txt s3://demo/docs/hello.txt
aws s3api put-object --bucket demo --key docs/meta.txt --body hello.txt \
  --content-type text/plain --metadata owner=alice,team=storage
aws s3api head-object --bucket demo --key docs/meta.txt
```

```console
$ aws s3api head-object --bucket demo --key docs/meta.txt
{
    "AcceptRanges": "bytes",
    "LastModified": "2026-09-24T08:15:12+00:00",
    "ContentLength": 13,
    "ETag": "\"b8f3e6c2a1d4e5f60718293a4b5c6d7e\"",
    "ContentType": "text/plain",
    "Metadata": {
        "owner": "alice",
        "team": "storage"
    }
}
```

单次 PUT 上传的对象，ETag 通常就是内容的 MD5，可以用来校验。再看看"目录错觉"：

```bash
aws s3 cp hello.txt s3://demo/a/b/c.txt
aws s3 ls s3://demo/
aws s3api list-objects-v2 --bucket demo --prefix a/ --delimiter /
```

```console
$ aws s3 ls s3://demo/
                           PRE a/
                           PRE docs/
$ aws s3api list-objects-v2 --bucket demo --prefix a/ --delimiter /
{
    "CommonPrefixes": [
        {
            "Prefix": "a/b/"
        }
    ],
    "KeyCount": 1
}
```

`a/` 和 `a/b/` 都不是真实存在的东西，删掉 `a/b/c.txt` 之后它们就一起"消失"了。

## 签名：SigV4

S3 不用会话、不用 Cookie，**每个请求都独立签名**。当前的标准是 AWS Signature Version 4（SigV4），过程分四步：

```text
1. 规范请求 (Canonical Request)
   HTTP 方法 + URI + 查询参数 + 参与签名的头 + 负载的 SHA256
                         │ SHA256
                         ▼
2. 待签字符串 (String to Sign)
   "AWS4-HMAC-SHA256" + 时间戳 + 范围(日期/区域/服务/aws4_request) + 上一步的哈希
                         │
3. 派生签名密钥：HMAC 链，Secret Key → 日期 → 区域 → 服务 → "aws4_request"
                         │ HMAC-SHA256
                         ▼
4. 签名 → 放进 Authorization 头（或预签名 URL 的查询参数）
```

几个设计意图：签名覆盖了方法、路径、关键头和负载哈希，请求被篡改就验证失败；带时间戳，服务端拒绝时间偏差过大（AWS 为 15 分钟）的请求，防止重放；Secret Key 从不在网络上传输。

curl 7.75 起内置 SigV4，可以不借助任何 SDK 直接看到签名头：

```bash
curl -sv --aws-sigv4 "aws:amz:us-east-1:s3" --user "rustfsadmin:rustfsadmin" \
  http://127.0.0.1:9000/demo/docs/hello.txt 2>&1 | grep -iE '^> (authorization|x-amz)'
```

```console
> Authorization: AWS4-HMAC-SHA256 Credential=rustfsadmin/20260924/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=9c2f4d...e81a
> X-Amz-Date: 20260924T081512Z
> x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

> [!TIP] SignatureDoesNotMatch 的常见原因
> 客户端时钟不准（先查 `timedatectl`）；region 写错；经过反向代理时 Host 头被改写；路径风格和虚拟主机风格混用；Secret Key 复制时带了空格。排查时让客户端打印规范请求（`aws --debug`），和服务端日志对比。

### 预签名 URL

签名也可以放进 URL 查询参数，生成一个限时有效的链接，拿到链接的人不需要任何凭证就能下载（或上传）：

```bash
URL=$(aws s3 presign s3://demo/docs/hello.txt --expires-in 300)
echo "$URL"
curl -s "$URL"                 # hello object
```

```text
http://127.0.0.1:9000/demo/docs/hello.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=rustfsadmin%2F20260924%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260924T081800Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=5b1e...
```

典型用法：浏览器直传——后端生成预签名 PUT URL 交给前端，文件直接上传到对象存储，不经过应用服务器。

## Multipart Upload：大对象怎么传

单个 PUT 请求传 50 GB 文件，中途断一次就得从头再来。分片上传（Multipart Upload）把对象拆成最多 10000 个分片（除最后一片外每片 5 MiB～5 GiB），可以并行上传、失败重传单片，最后一次性"拼装"：

```text
CreateMultipartUpload ──▶ UploadId
UploadPart ×N（可并行、可重试） ──▶ 每片一个 ETag
CompleteMultipartUpload(分片号 + ETag 列表) ──▶ 对象整体可见
（或 AbortMultipartUpload 放弃）
```

`aws s3 cp` 超过 8 MiB 会自动分片。手工走一遍底层 API 更能看清楚：

```bash
dd if=/dev/urandom of=big.bin bs=1M count=20
split -b 8M big.bin part-            # part-aa part-ab part-ac
UPLOAD_ID=$(aws s3api create-multipart-upload --bucket demo --key big.bin \
  --query UploadId --output text)
n=1
for f in part-*; do
  aws s3api upload-part --bucket demo --key big.bin --upload-id "$UPLOAD_ID" \
    --part-number $n --body "$f" --query ETag --output text
  n=$((n+1))
done
aws s3api list-parts --bucket demo --key big.bin --upload-id "$UPLOAD_ID" \
  --query '{Parts: Parts[].{ETag: ETag, PartNumber: PartNumber}}' > parts.json
aws s3api complete-multipart-upload --bucket demo --key big.bin \
  --upload-id "$UPLOAD_ID" --multipart-upload file://parts.json
aws s3api head-object --bucket demo --key big.bin --query ETag
```

```console
"\"6f1c2a9e0b7d4c3e8a5f1d2b3c4e5f60-3\""
```

注意 ETag 结尾的 `-3`：分片上传对象的 ETag 不是整个文件的 MD5，而是各分片 MD5 拼接后再算一次 MD5，加上分片数。用 ETag 校验文件完整性的脚本经常在这里翻车。

> [!PROD] 清理未完成的分片上传
> 客户端崩溃后留下的未完成分片上传，分片数据会一直占着空间，却不会出现在 `aws s3 ls` 里。用 `aws s3api list-multipart-uploads --bucket <桶>` 检查，并给每个桶配置 `AbortIncompleteMultipartUpload` 生命周期规则自动清理。

## 版本控制与生命周期

开启版本控制后，覆盖和删除都不会真正丢掉旧数据：覆盖生成新版本，删除只是插入一个**删除标记**（delete marker）。

```bash
aws s3api put-bucket-versioning --bucket demo --versioning-configuration Status=Enabled
echo v1 > v.txt && aws s3 cp v.txt s3://demo/v.txt
echo v2 > v.txt && aws s3 cp v.txt s3://demo/v.txt
aws s3 rm s3://demo/v.txt
aws s3api list-object-versions --bucket demo --prefix v.txt \
  --query '{V: Versions[].[VersionId,IsLatest,Size], D: DeleteMarkers[].[VersionId,IsLatest]}'
```

`aws s3 ls` 已经看不到 `v.txt`，但两个版本都还在；删除那个删除标记（`aws s3api delete-object --bucket demo --key v.txt --version-id <标记的ID>`），对象就"复活"了。版本控制是防误删和勒索软件的第一道防线，代价是每个旧版本都占用空间，必须配合生命周期规则：

```json title="lifecycle.json"
{
  "Rules": [
    {
      "ID": "logs-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "logs/" },
      "Expiration": { "Days": 30 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket demo --lifecycle-configuration file://lifecycle.json
aws s3api get-bucket-lifecycle-configuration --bucket demo
```

生命周期还能做**分层**（Transition）：对象超过 N 天后迁移到更便宜的存储层（AWS 的 Glacier，或自建集群里的 HDD 池、另一个集群）。不同 S3 兼容实现对生命周期动作的支持程度不一，上线前务必在自己的版本上验证。

## 一致性：S3 自 2020 年起强一致

2020 年 12 月之前，AWS S3 对覆盖写和删除只是最终一致：刚覆盖完立刻读，可能读到旧内容；刚上传完立刻 LIST，可能看不到。大数据框架为此发明了 S3Guard 之类的补丁。2020 年 12 月起，S3 对所有对象的 PUT、DELETE 以及随后的 GET、LIST 提供**强读后写一致性**（strong read-after-write consistency），而且不额外收费。Ceph RGW、MinIO、RustFS 这些自建实现本来就是强一致的。

强一致不等于有锁。两个客户端同时 PUT 同一个 key，结果是"最后完成的那个赢"，另一个的写入被静默覆盖。需要防止覆盖时，用条件写：`PutObject` 带 `If-None-Match: *`（对象不存在才写）或 `If-Match: <ETag>`（内容没变才写）。AWS 在 2024 年支持了这两种条件写，自建实现的支持情况要逐一确认。

## 小对象与 LIST：对象存储的软肋

### 小对象

每个对象无论多小，都要付出固定的开销：一次 HTTP 请求（签名、TLS、连接）、一条元数据索引记录、至少一个最小分配单元（EC 池里还要乘以 k+m，见[副本与纠删码](/learn/replication-ec)）。对比一下两个工具上传 10000 个 4 KiB 文件：

```bash
mkdir -p small && for i in $(seq 1 10000); do head -c 4096 /dev/urandom > small/f$i; done

time aws s3 cp --recursive --quiet small s3://demo/small-aws/

curl -sSL https://github.com/peak/s5cmd/releases/download/v2.3.0/s5cmd_2.3.0_Linux-64bit.tar.gz \
  | tar xz s5cmd && sudo mv s5cmd /usr/local/bin/
time s5cmd --profile local --endpoint-url http://127.0.0.1:9000 cp 'small/*' s3://demo/small-s5/
```

```console
real    0m58.214s      # aws s3 cp，默认 10 个并发
real    0m4.873s       # s5cmd，默认 256 个并发 worker
```

同样 40 MB 数据，耗时差了十几倍，瓶颈完全是请求数和并发度，和带宽无关。s5cmd 是 Go 写的高并发 S3 客户端，版本以其 GitHub 发布页为准；`mc` 是 MinIO 的客户端，用法类似（`mc alias set local http://127.0.0.1:9000 rustfsadmin rustfsadmin` 后 `mc cp --recursive small local/demo/small-mc/`）。

小对象的根本解法不是换工具，而是**合并**：训练数据打包成 tar 分片（WebDataset）、TFRecord 或 Parquet，日志按小时合并成大文件。经验值是让单个对象至少在几 MB 以上。

### LIST

LIST 按 key 的字典序分页返回，每页最多 1000 个，下一页要带上上一页的 continuation token，**只能串行翻页**。一个前缀下 1 亿个对象，全量列举就是 10 万次串行请求。

```bash
time s5cmd --profile local --endpoint-url http://127.0.0.1:9000 ls 's3://demo/small-s5/*' | wc -l
```

应对办法：

- **按前缀分桶并行列举**：key 设计成 `logs/2026/09/24/...` 或带哈希前缀 `a7/...`，工具可以对多个前缀并行 LIST；
- **不要用 LIST 当数据库**：需要"找出所有属于用户 X 的对象"，把索引存在数据库里；
- **注意请求速率**：AWS S3 每个前缀每秒约支持 3500 次写和 5500 次读请求，热点集中在单一前缀会被限速（返回 503 SlowDown）；自建集群的上限则取决于元数据索引的性能（例如 Ceph RGW 的桶索引分片）。

## 动手练习

1. 按本课步骤启动 RustFS 并配置 `aws` profile，创建桶，上传一个带用户元数据的对象，分别用 `head-object` 和带 `--aws-sigv4` 的 `curl -I` 查看元数据。
2. 手工完成一次三片的分片上传，验证下载后的文件 md5 与原文件一致，并解释 ETag 为什么带 `-3`。再开始一次分片上传但不完成，用 `list-multipart-uploads` 找到它并 abort。
3. 生成一个有效期 60 秒的预签名 URL，立即用 curl 下载成功；等待 70 秒后再试，观察返回的错误码。
4. 开启版本控制，覆盖一个对象两次再删除，用 `list-object-versions` 找到删除标记，删除它让对象"复活"，最后下载指定的旧版本（`get-object --version-id`）。
5. 分别用 `aws s3 cp --recursive` 和 `s5cmd` 上传 10000 个 4 KiB 小文件与 1 个 40 MiB 大文件，记录耗时，写一段话解释差别。

## 自测

<details>
<summary>对象存储里"重命名一个目录"实际发生了什么？为什么说它不是原子的？</summary>

对象存储没有目录，"目录"只是 key 的公共前缀。重命名目录需要先 LIST 出该前缀下所有对象，再逐个 CopyObject 到新 key、DeleteObject 旧 key。这是大量独立请求，中途失败会留下一部分在新前缀、一部分在旧前缀，其他客户端在过程中也会看到中间状态，因此不是原子的。

</details>

<details>
<summary>SigV4 签名中为什么要包含时间戳和负载的 SHA256？</summary>

时间戳让服务端可以拒绝时间偏差过大的请求，防止请求被截获后重放；负载哈希把请求体也纳入签名，请求体被篡改后签名验证就会失败。同时 Secret Key 本身不在网络上传输，只用于在本地计算 HMAC。

</details>

<details>
<summary>为什么分片上传对象的 ETag 不能直接当作文件的 MD5 来校验？</summary>

分片上传对象的 ETag 是把各分片的 MD5 二进制值拼接后再计算一次 MD5，并加上 `-分片数` 后缀。它依赖分片大小的划分方式，与整个文件的 MD5 不同。校验时需要按相同的分片大小重新计算，或使用 S3 的附加校验和（如 CRC32C、SHA256）功能。

</details>

<details>
<summary>S3 从 2020 年起是强一致的，那两个客户端同时 PUT 同一个 key 会怎样？如何避免互相覆盖？</summary>

强一致保证写入完成后的读取能看到最新结果，但不提供锁。并发 PUT 时最后完成的写入生效，另一个被静默覆盖。可以使用条件写：`If-None-Match: *` 保证只在对象不存在时创建，`If-Match: <ETag>` 保证只在对象未被他人修改时覆盖，失败时返回 412，由应用决定如何处理。

</details>

<details>
<summary>上传 10000 个 4 KiB 文件比上传 1 个 40 MiB 文件慢得多，瓶颈在哪？有哪些改进方法？</summary>

瓶颈在每个对象的固定开销：一次 HTTP 请求的往返、签名计算、服务端的元数据写入和最小分配单元，和带宽无关。改进方法包括提高并发度（如使用 s5cmd），以及从根本上把小文件合并成大对象（tar 分片、WebDataset、Parquet 等）。

</details>

## 参考资料

- [Amazon S3 用户指南：对象键命名](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html)
- [Amazon S3 用户指南：分片上传](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Amazon S3 用户指南：数据一致性模型](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- [Amazon S3 用户指南：条件写入](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [AWS 文档：Signature Version 4 签名流程](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html)
- [Amazon S3 用户指南：优化性能的最佳实践](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [AWS CLI 用户指南：安装 AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [RustFS 项目主页](https://github.com/rustfs/rustfs)
- [s5cmd 项目主页](https://github.com/peak/s5cmd)
- [curl 手册：--aws-sigv4](https://curl.se/docs/manpage.html#--aws-sigv4)
